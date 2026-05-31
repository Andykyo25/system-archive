// 集保戶數 / 外資持股 fetcher(週頻)
// FinMind TaiwanStockShareholding 給每檔股的「外資持股比例 / 上限 / 已發行股數」週快照

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const FINMIND_DAILY_BUDGET = 600;
const LOOKBACK_DAYS = 30; // 抓最近 30 天確保補齊任何遺漏

interface ShareholdingRow {
  symbol: string;
  report_date: string;
  foreign_remaining_shares: number | null;
  foreign_used_shares: number | null;
  foreign_remain_ratio: number | null;
  foreign_holding_ratio: number | null;
  foreign_upper_limit_ratio: number | null;
  chinese_upper_limit_ratio: number | null;
  shares_issued: number | null;
  recently_declared_date: string | null;
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

function toN(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchShareholdingForSymbol(
  token: string,
  symbol: string,
  startDate: string,
  endDate: string,
): Promise<ShareholdingRow[]> {
  const u = new URL(FINMIND_URL);
  u.searchParams.set("dataset", "TaiwanStockShareholding");
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
  return (j.data as any[]).flatMap((r): ShareholdingRow[] => [{
    symbol: String(r.stock_id),
    report_date: String(r.date),
    foreign_remaining_shares: toN(r.ForeignInvestmentRemainingShares),
    foreign_used_shares: toN(r.ForeignInvestmentShares),
    foreign_remain_ratio: toN(r.ForeignInvestmentRemainRatio),
    foreign_holding_ratio: toN(r.ForeignInvestmentSharesRatio),
    foreign_upper_limit_ratio: toN(r.ForeignInvestmentUpperLimitRatio),
    chinese_upper_limit_ratio: toN(r.ChineseInvestmentUpperLimitRatio),
    shares_issued: toN(r.NumberOfSharesIssued),
    recently_declared_date: r.RecentlyDeclareDate ? String(r.RecentlyDeclareDate) : null,
  }]);
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
    .from("fetch_log").insert({ source: "finmind_shareholding" }).select("id").single();
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
      const rows = await fetchShareholdingForSymbol(TOKEN, symbol, startDate, today);
      if (rows.length > 0) {
        const { error } = await supabase
          .from("stock_shareholding")
          .upsert(rows, { onConflict: "symbol,report_date", ignoreDuplicates: true });
        if (error) throw error;
        written += rows.length;
      }
    } catch (e) {
      errors.push(`${symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // B1:原子遞增(取代 read-modify-write,並行不覆蓋)
  await supabase.rpc("increment_quota", { p_source: "finmind", p_date: today, p_n: apiCalls });

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
