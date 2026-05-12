// 借券交易明細 fetcher
// FinMind TaiwanStockSecuritiesLending 是明細性質,每筆借券一個 row

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const FINMIND_DAILY_BUDGET = 600;
const LOOKBACK_DAYS = 10;

interface LendingRow {
  symbol: string;
  trade_date: string;
  transaction_type: string | null;
  volume: number | null;
  fee_rate: number | null;
  close_price: number | null;
  original_return_date: string | null;
  original_lending_period: number | null;
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

async function fetchLendingForSymbol(
  token: string,
  symbol: string,
  startDate: string,
  endDate: string,
): Promise<LendingRow[]> {
  const u = new URL(FINMIND_URL);
  u.searchParams.set("dataset", "TaiwanStockSecuritiesLending");
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
  return (j.data as any[]).flatMap((r): LendingRow[] => [{
    symbol: String(r.stock_id),
    trade_date: String(r.date),
    transaction_type: r.transaction_type ? String(r.transaction_type) : null,
    volume: toN(r.volume),
    fee_rate: toN(r.fee_rate),
    close_price: toN(r.close),
    original_return_date: r.original_return_date ? String(r.original_return_date) : null,
    original_lending_period: toN(r.original_lending_period),
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

  const [holdingsCurrent, watchlist, industry, universe] = await Promise.all([
    supabase.from("v_holdings_current").select("symbol"),
    supabase.from("watchlist").select("symbol"),
    supabase.from("industry_stocks").select("symbol"),
    supabase.from("stock_universe").select("symbol"),
  ]);
  const targetSymbols = new Set<string>();
  if (holdingsCurrent.error) {
    const { data: oldHoldings } = await supabase.from("holdings").select("symbol").is("closed_at", null);
    for (const r of oldHoldings ?? []) targetSymbols.add(r.symbol);
  } else {
    for (const r of holdingsCurrent.data ?? []) targetSymbols.add(r.symbol);
  }
  for (const r of watchlist.data ?? []) targetSymbols.add(r.symbol);
  for (const r of industry.data ?? []) targetSymbols.add(r.symbol);
  for (const r of universe.data ?? []) targetSymbols.add(r.symbol);
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
    .from("fetch_log").insert({ source: "finmind_lending" }).select("id").single();
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
      const rows = await fetchLendingForSymbol(TOKEN, symbol, startDate, today);
      if (rows.length > 0) {
        // 借券明細用 (symbol, trade_date, transaction_type, volume, fee_rate) 做 unique
        // 而非 PK,因為同一檔同一天可能有多筆借券
        const { error } = await supabase
          .from("stock_securities_lending")
          .upsert(rows, {
            onConflict: "symbol,trade_date,transaction_type,volume,fee_rate",
            ignoreDuplicates: true,
          });
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
