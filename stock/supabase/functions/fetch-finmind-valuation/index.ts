import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const FINMIND_DAILY_BUDGET = 600;
const LOOKBACK_DAYS = 7;

interface ValuationRow {
  symbol: string;
  trade_date: string;
  pe: number | null;
  pb: number | null;
  dividend_yield: number | null;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

async function fetchValuationForSymbol(
  token: string,
  symbol: string,
  startDate: string,
  endDate: string,
): Promise<ValuationRow[]> {
  const u = new URL(FINMIND_URL);
  u.searchParams.set("dataset", "TaiwanStockPER");
  u.searchParams.set("data_id", symbol);
  u.searchParams.set("start_date", startDate);
  u.searchParams.set("end_date", endDate);
  u.searchParams.set("token", token);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.status !== 200) throw new Error(`FinMind status=${j.status} msg=${j.msg}`);
  if (!Array.isArray(j.data)) return [];
  // deno-lint-ignore no-explicit-any
  return (j.data as any[]).map((r): ValuationRow => ({
    symbol: String(r.stock_id),
    trade_date: String(r.date),
    pe: Number.isFinite(Number(r.PER)) ? Number(r.PER) : null,
    pb: Number.isFinite(Number(r.PBR)) ? Number(r.PBR) : null,
    dividend_yield: Number.isFinite(Number(r.dividend_yield)) ? Number(r.dividend_yield) : null,
  }));
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return Response.json({ error: "missing bearer" }, { status: 401 });
  let role: unknown;
  try {
    role = decodeJwtPayload(auth.slice(7)).role;
  } catch {
    return Response.json({ error: "invalid jwt" }, { status: 401 });
  }
  if (role !== "service_role") return Response.json({ error: "forbidden", role }, { status: 403 });

  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SERVICE_ROLE) return Response.json({ error: "missing SUPABASE_SERVICE_ROLE_KEY env" }, { status: 500 });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);

  const tokenRes = await supabase.rpc("read_finmind_token");
  if (tokenRes.error || !tokenRes.data) {
    return Response.json({ error: "missing finmind_token in vault", detail: tokenRes.error?.message }, { status: 500 });
  }
  const TOKEN = tokenRes.data as string;

  // 收料 symbol 單一來源 v_fetch_universe(根治 holdings_transactions 漏收 drift)。
  // fallback:view 異常 → 退回原 holdings/watchlist/industry/etf query(零退化)。
  const fu = await supabase.from("v_fetch_universe").select("symbol");
  const targetSymbols = new Set<string>();
  if (fu.error) {
    const [holdings, watchlist, industry, etf] = await Promise.all([
      supabase.from("holdings").select("symbol").is("closed_at", null),
      supabase.from("watchlist").select("symbol"),
      supabase.from("industry_stocks").select("symbol"),
      supabase.from("etf_metadata").select("symbol"),
    ]);
    for (const r of holdings.data ?? []) targetSymbols.add(r.symbol);
    for (const r of watchlist.data ?? []) targetSymbols.add(r.symbol);
    for (const r of industry.data ?? []) targetSymbols.add(r.symbol);
    for (const r of etf.data ?? []) targetSymbols.add(r.symbol);
  } else {
    for (const r of fu.data ?? []) targetSymbols.add(r.symbol);
  }
  if (targetSymbols.size === 0) return Response.json({ skipped: "no_target_symbols" });

  const today = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString().slice(0, 10);

  await supabase.from("api_quota_state").upsert(
    { source: "finmind", quota_date: today, used: 0, budget: FINMIND_DAILY_BUDGET },
    { onConflict: "source,quota_date", ignoreDuplicates: true },
  );
  const { data: quotaRow } = await supabase
    .from("api_quota_state")
    .select("used, budget")
    .eq("source", "finmind")
    .eq("quota_date", today)
    .single();
  const usedSoFar = quotaRow?.used ?? 0;
  const budget = quotaRow?.budget ?? FINMIND_DAILY_BUDGET;
  const remaining = budget - usedSoFar;
  if (remaining < 1) {
    return Response.json({ skipped: "quota_exhausted", quota: { used: usedSoFar, budget } });
  }

  const { data: logRow } = await supabase.from("fetch_log").insert({ source: "finmind_valuation" }).select("id").single();
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
      const rows = await fetchValuationForSymbol(TOKEN, symbol, startDate, today);
      if (rows.length > 0) {
        const { error } = await supabase
          .from("stock_pe_pb_daily")
          .upsert(rows, { onConflict: "symbol,trade_date" });
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
