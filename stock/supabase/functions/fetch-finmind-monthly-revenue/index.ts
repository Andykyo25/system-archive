import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const FINMIND_DAILY_BUDGET = 600;
const LOOKBACK_DAYS = 800; // ~25 個月歷史(夠算 12 月 YoY + buffer)

interface RevenueRow {
  symbol: string;
  period_year: number;
  period_month: number;
  revenue: number;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

async function fetchRevenueForSymbol(
  token: string,
  symbol: string,
  startDate: string,
  endDate: string,
): Promise<RevenueRow[]> {
  const u = new URL(FINMIND_URL);
  u.searchParams.set("dataset", "TaiwanStockMonthRevenue");
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
  return (j.data as any[]).flatMap((r): RevenueRow[] => {
    const rev = Number(r.revenue);
    const y = parseInt(String(r.revenue_year), 10);
    const m = parseInt(String(r.revenue_month), 10);
    if (!Number.isFinite(rev) || !Number.isFinite(y) || !Number.isFinite(m)) return [];
    return [{ symbol: String(r.stock_id), period_year: y, period_month: m, revenue: rev }];
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

  // body.token_key:預設 finmind_token(token_1,共用 daily quota 與其他 finmind_* EF);
  //   傳 'finmind_token_2' → 用獨立 token_2(600 daily 獨立 quota)
  //   對應 vault RPC + quota source 切換,fetch_log source 維持 'finmind_monthly_revenue' 便聚合
  //   2026-07-22:主 token 連 3 天 600/600 用滿,本 EF(週日 20:00)排在最後 → quota_exhausted。
  //   改由 cron 傳 token_2。
  let bodyJson: { token_key?: string } = {};
  try { bodyJson = await req.json(); } catch { /* no body OK */ }
  const useTok2 = bodyJson.token_key === "finmind_token_2";
  const rpcName = useTok2 ? "read_finmind_token_2" : "read_finmind_token";
  const quotaSource = useTok2 ? "finmind_2" : "finmind";

  const tokenRes = await supabase.rpc(rpcName);
  if (tokenRes.error || !tokenRes.data) {
    return Response.json({ error: `missing ${useTok2 ? "finmind_token_2" : "finmind_token"} in vault`, detail: tokenRes.error?.message }, { status: 500 });
  }
  const TOKEN = tokenRes.data as string;

  // ETF 沒月營收,只抓個股
  // 收料 symbol 單一來源 v_fetch_universe(根治 holdings_transactions 漏收 drift)。
  // fallback:view 異常 → 退回原 holdings/watchlist/industry query(零退化)。
  const fu = await supabase.from("v_fetch_universe").select("symbol");
  const targetSymbols = new Set<string>();
  if (fu.error) {
    const [holdings, watchlist, industry] = await Promise.all([
      supabase.from("holdings").select("symbol").is("closed_at", null),
      supabase.from("watchlist").select("symbol"),
      supabase.from("industry_stocks").select("symbol"),
    ]);
    for (const r of holdings.data ?? []) targetSymbols.add(r.symbol);
    for (const r of watchlist.data ?? []) targetSymbols.add(r.symbol);
    for (const r of industry.data ?? []) targetSymbols.add(r.symbol);
  } else {
    for (const r of fu.data ?? []) targetSymbols.add(r.symbol);
  }
  if (targetSymbols.size === 0) return Response.json({ skipped: "no_target_symbols" });

  const today = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString().slice(0, 10);

  await supabase.from("api_quota_state").upsert(
    { source: quotaSource, quota_date: today, used: 0, budget: FINMIND_DAILY_BUDGET },
    { onConflict: "source,quota_date", ignoreDuplicates: true },
  );
  const { data: quotaRow } = await supabase
    .from("api_quota_state").select("used, budget")
    .eq("source", quotaSource).eq("quota_date", today).single();
  const usedSoFar = quotaRow?.used ?? 0;
  const budget = quotaRow?.budget ?? FINMIND_DAILY_BUDGET;
  const remaining = budget - usedSoFar;
  if (remaining < 1) {
    return Response.json({ skipped: "quota_exhausted", quota: { used: usedSoFar, budget } });
  }

  const { data: logRow } = await supabase
    .from("fetch_log").insert({ source: "finmind_monthly_revenue" }).select("id").single();
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
      const rows = await fetchRevenueForSymbol(TOKEN, symbol, startDate, today);
      if (rows.length > 0) {
        const { error } = await supabase
          .from("stock_monthly_revenue")
          .upsert(rows, { onConflict: "symbol,period_year,period_month" });
        if (error) throw error;
        written += rows.length;
      }
    } catch (e) {
      errors.push(`${symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // B1:原子遞增(取代 read-modify-write,並行不覆蓋)
  await supabase.rpc("increment_quota", { p_source: quotaSource, p_date: today, p_n: apiCalls });

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
