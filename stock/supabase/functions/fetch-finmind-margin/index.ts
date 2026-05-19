// 融資融券餘額 fetcher
// FinMind TaiwanStockMarginPurchaseShortSale 是 wide format,
// 每 (date, stock_id) 一筆 row,欄位全是中文化資料

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const FINMIND_DAILY_BUDGET = 600;
const LOOKBACK_DAYS = 10;

interface MarginRow {
  symbol: string;
  trade_date: string;
  margin_buy: number;
  margin_sell: number;
  margin_cash_repay: number;
  margin_balance: number;
  margin_balance_prev: number;
  margin_delta: number;
  margin_limit: number;
  short_sell: number;
  short_buy: number;
  short_cash_repay: number;
  short_balance: number;
  short_balance_prev: number;
  short_delta: number;
  short_limit: number;
  offset_loan_and_short: number;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
}

function toN(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function fetchMarginForSymbol(
  token: string,
  symbol: string,
  startDate: string,
  endDate: string,
): Promise<MarginRow[]> {
  const u = new URL(FINMIND_URL);
  u.searchParams.set("dataset", "TaiwanStockMarginPurchaseShortSale");
  u.searchParams.set("data_id", symbol);
  u.searchParams.set("start_date", startDate);
  u.searchParams.set("end_date", endDate);
  u.searchParams.set("token", token);

  const res = await fetch(u);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 200) throw new Error(`FinMind status=${j.status} msg=${j.msg}`);
  if (!Array.isArray(j.data)) return [];

  // deno-lint-ignore no-explicit-any
  return (j.data as any[]).flatMap((r): MarginRow[] => {
    const margin_balance = toN(r.MarginPurchaseTodayBalance);
    const margin_balance_prev = toN(r.MarginPurchaseYesterdayBalance);
    const short_balance = toN(r.ShortSaleTodayBalance);
    const short_balance_prev = toN(r.ShortSaleYesterdayBalance);
    return [{
      symbol: String(r.stock_id),
      trade_date: String(r.date),
      margin_buy: toN(r.MarginPurchaseBuy),
      margin_sell: toN(r.MarginPurchaseSell),
      margin_cash_repay: toN(r.MarginPurchaseCashRepayment),
      margin_balance,
      margin_balance_prev,
      margin_delta: margin_balance - margin_balance_prev,
      margin_limit: toN(r.MarginPurchaseLimit),
      short_sell: toN(r.ShortSaleSell),
      short_buy: toN(r.ShortSaleBuy),
      short_cash_repay: toN(r.ShortSaleCashRepayment),
      short_balance,
      short_balance_prev,
      short_delta: short_balance - short_balance_prev,
      short_limit: toN(r.ShortSaleLimit),
      offset_loan_and_short: toN(r.OffsetLoanAndShort),
    }];
  });
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return Response.json({ error: "missing bearer" }, { status: 401 });
  let role: unknown;
  try { role = decodeJwtPayload(auth.slice(7)).role; }
  catch { return Response.json({ error: "invalid jwt" }, { status: 401 }); }
  if (role !== "service_role") return Response.json({ error: "forbidden", role }, { status: 403 });

  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SERVICE_ROLE) return Response.json({ error: "missing SUPABASE_SERVICE_ROLE_KEY env" }, { status: 500 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);

  const tokenRes = await supabase.rpc("read_finmind_token");
  if (tokenRes.error || !tokenRes.data) {
    return Response.json({ error: "missing finmind_token in vault", detail: tokenRes.error?.message }, { status: 500 });
  }
  const TOKEN = tokenRes.data as string;

  // 收料 symbol 單一來源 v_fetch_universe_stocks(L42 做法3 籌碼側統一,根治兩套 pattern drift)。
  // fallback:view 異常 → 退回原 v_holdings_current/watchlist/industry/stock_universe query(零退化,鏡像 c4e850f)。
  const fu = await supabase.from("v_fetch_universe_stocks").select("symbol");
  const targetSymbols = new Set<string>();
  if (fu.error) {
    const [holdingsCurrent, watchlist, industry, universe] = await Promise.all([
      supabase.from("v_holdings_current").select("symbol"),
      supabase.from("watchlist").select("symbol"),
      supabase.from("industry_stocks").select("symbol"),
      supabase.from("stock_universe").select("symbol"),
    ]);
    if (holdingsCurrent.error) {
      const { data: oldHoldings } = await supabase.from("holdings").select("symbol").is("closed_at", null);
      for (const r of oldHoldings ?? []) targetSymbols.add(r.symbol);
    } else {
      for (const r of holdingsCurrent.data ?? []) targetSymbols.add(r.symbol);
    }
    for (const r of watchlist.data ?? []) targetSymbols.add(r.symbol);
    for (const r of industry.data ?? []) targetSymbols.add(r.symbol);
    for (const r of universe.data ?? []) targetSymbols.add(r.symbol);
  } else {
    for (const r of fu.data ?? []) targetSymbols.add(r.symbol);
  }
  if (targetSymbols.size === 0) return Response.json({ skipped: "no_target_symbols" });

  const today = new Date().toISOString().slice(0, 10);
  const startDate = isoDaysAgo(LOOKBACK_DAYS);

  await supabase.from("api_quota_state").upsert(
    { source: "finmind", quota_date: today, used: 0, budget: FINMIND_DAILY_BUDGET },
    { onConflict: "source,quota_date", ignoreDuplicates: true },
  );
  const { data: quotaRow } = await supabase
    .from("api_quota_state").select("used, budget")
    .eq("source", "finmind").eq("quota_date", today).single();
  const usedSoFar = quotaRow?.used ?? 0;
  const budget = quotaRow?.budget ?? FINMIND_DAILY_BUDGET;
  const remaining = budget - usedSoFar;
  if (remaining < 1) {
    return Response.json({ skipped: "quota_exhausted", quota: { used: usedSoFar, budget } });
  }

  const { data: logRow } = await supabase
    .from("fetch_log").insert({ source: "finmind_margin" }).select("id").single();
  const logId = logRow!.id;

  let written = 0;
  let apiCalls = 0;
  const errors: string[] = [];

  for (const symbol of targetSymbols) {
    if (apiCalls >= remaining) {
      errors.push(`quota exhausted at ${symbol}`);
      break;
    }
    try {
      apiCalls++;
      const rows = await fetchMarginForSymbol(TOKEN, symbol, startDate, today);
      if (rows.length > 0) {
        const { error } = await supabase
          .from("stock_margin")
          .upsert(rows, { onConflict: "symbol,trade_date", ignoreDuplicates: true });
        if (error) throw error;
        written += rows.length;
      }
    } catch (e) {
      errors.push(`${symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await supabase.from("api_quota_state")
    .update({ used: usedSoFar + apiCalls })
    .eq("source", "finmind").eq("quota_date", today);

  await supabase.from("fetch_log").update({
    finished_at: new Date().toISOString(),
    success: errors.length === 0,
    rows_written: written,
    error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null,
  }).eq("id", logId);

  return Response.json({
    target_symbols: targetSymbols.size,
    api_calls: apiCalls,
    written,
    errors: errors.length,
    quota: { used: usedSoFar + apiCalls, budget },
  });
});
