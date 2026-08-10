import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const LOOKBACK_DAYS = 7;
const FINMIND_DAILY_BUDGET = 600; // free tier baseline (保守值)

interface PriceRow {
  symbol: string;
  trade_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  source: "finmind";
  is_provisional: true;
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

async function fetchFinmindForSymbol(
  token: string,
  symbol: string,
  startDate: string,
  endDate: string,
): Promise<PriceRow[]> {
  const url = new URL(FINMIND_URL);
  url.searchParams.set("dataset", "TaiwanStockPrice");
  url.searchParams.set("data_id", symbol);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("token", token);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 200) {
    throw new Error(`FinMind status=${json.status} msg=${json.msg}`);
  }
  if (!Array.isArray(json.data)) return [];

  // deno-lint-ignore no-explicit-any
  return (json.data as any[]).flatMap((r): PriceRow[] => {
    const close = parseFloat(String(r.close));
    if (!Number.isFinite(close) || close <= 0) return []; // close<=0 = 未交易/停牌/髒資料,不寫
    return [{
      symbol: String(r.stock_id),
      trade_date: String(r.date),
      open: parseFloat(String(r.open)) || null,
      high: parseFloat(String(r.max)) || null,  // FinMind 用 max/min,不是 high/low
      low: parseFloat(String(r.min)) || null,
      close,
      volume: parseInt(String(r.Trading_Volume), 10) || null,
      source: "finmind",
      is_provisional: true,
    }];
  });
}

Deno.serve(async (req: Request) => {
  // Auth: 同 fetch-daily-prices,只認 service_role JWT
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return Response.json({ error: "missing bearer" }, { status: 401 });
  }
  let role: unknown;
  try {
    role = decodeJwtPayload(auth.slice(7)).role;
  } catch {
    return Response.json({ error: "invalid jwt" }, { status: 401 });
  }
  if (role !== "service_role") {
    return Response.json({ error: "forbidden", role }, { status: 403 });
  }

  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SERVICE_ROLE) {
    return Response.json({ error: "missing SUPABASE_SERVICE_ROLE_KEY env" }, { status: 500 });
  }
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);

  // 從 vault 取 FinMind token(透過 SECURITY DEFINER RPC)
  const tokenRes = await supabase.rpc("read_finmind_token");
  if (tokenRes.error || !tokenRes.data) {
    return Response.json({
      error: "missing finmind_token in vault",
      detail: tokenRes.error?.message,
    }, { status: 500 });
  }
  const FINMIND_TOKEN = tokenRes.data as string;

  // 取目標 symbols
  //
  // 修法歷史 (L46,2026-05-21):
  //   ❌ 舊版只讀 holdings(closed_at null)+ watchlist + industry + etf,**漏 holdings_transactions(M8.5)+ stock_universe**
  //      → 6285 (transaction-log 記的持股) 完全沒進 set,5-20 fallback 跑時 6285 沒寫進 price_daily
  //      → 推播誤導 stale price (L46:L42 修法漏網,partial migration 重演)
  //   ✅ 新版同 c4e850f 修法,改用 v_fetch_universe(單一事實來源),fallback 保留舊邏輯
  //
  // 持股優先(L46 額外):quota 緊張時 v_holdings_current 先加進 set,Set 迭代依 insertion order
  //   → 持股一定先抓,確保推播絕不 stale(即使 quota 跑不完整 universe)
  const [holdingsCurrent, fu] = await Promise.all([
    supabase.from("v_holdings_current").select("symbol"),
    supabase.from("v_fetch_universe").select("symbol"),
  ]);

  const targetSymbols = new Set<string>();
  // 1. 持股優先進 set
  for (const r of holdingsCurrent.data ?? []) targetSymbols.add(r.symbol);
  // 2. v_fetch_universe(view 異常 → fallback 到原 4-source inline query,零退化)
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

  if (targetSymbols.size === 0) {
    return Response.json({ skipped: "no_target_symbols" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const startDate = isoDaysAgo(LOOKBACK_DAYS);

  // Quota:每日初始化一次 row,然後讀剩餘額度
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
  if (remaining <= 0) {
    return Response.json({
      skipped: "quota_exhausted",
      quota: { used: usedSoFar, budget },
    });
  }

  // 預先撈 price_daily 已有的 (symbol, date),這樣 FinMind 回來的 row 就能 client-side 過濾掉
  // 任何已經存在的(不論主力或 fallback)都不再寫
  const { data: existing } = await supabase
    .from("price_daily")
    .select("symbol, trade_date")
    .in("symbol", Array.from(targetSymbols))
    .gte("trade_date", startDate)
    .lte("trade_date", today);
  const existingKeys = new Set(
    (existing ?? []).map((r) => `${r.symbol}|${r.trade_date}`),
  );

  // 建一筆 fetch_log
  const { data: logRow } = await supabase
    .from("fetch_log").insert({ source: "finmind" }).select("id").single();
  const logId = logRow!.id;

  let written = 0;
  let skipped = 0;
  let apiCalls = 0;
  const errors: string[] = [];

  // 只補洞:當日已有資料的 symbol 直接跳過,不打 API。
  //
  // 2026-08-11:594 檔 universe × 1 call = 594,單一個 EF 就吃光 token 一天的 600,
  // 排在後面的 valuation/margin/lending/institutional 全部 quota_exhausted。
  // 本 EF 跑在 06:30 收料 + 06:45 補洞之後,免費源(tpex 當日 / MI_INDEX 當日)覆蓋得到的
  // 就不該再花 quota —— 免費源健康時 api_calls 趨近 0,免費源掛掉時自動打滿,不退化。
  // 已知殘留成本:國定假日全市場都沒有當日資料 → 仍會掃滿(與修改前相同,無新增風險)。
  let alreadyCovered = 0;
  for (const symbol of targetSymbols) {
    if (existingKeys.has(`${symbol}|${today}`)) {
      alreadyCovered++;
      continue;
    }
    if (apiCalls >= remaining) {
      errors.push(`quota exhausted at symbol ${symbol}`);
      break;
    }
    try {
      apiCalls++;
      const rows = await fetchFinmindForSymbol(FINMIND_TOKEN, symbol, startDate, today);
      const toInsert = rows.filter((r) => !existingKeys.has(`${r.symbol}|${r.trade_date}`));
      if (toInsert.length === 0) {
        skipped += rows.length;
        continue;
      }
      const { data, error } = await supabase
        .from("price_daily")
        .upsert(toInsert, { onConflict: "symbol,trade_date", ignoreDuplicates: true })
        .select("symbol");
      if (error) throw error;
      const wrote = data?.length ?? 0;
      written += wrote;
      skipped += (rows.length - wrote);
    } catch (e) {
      errors.push(`${symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 更新 quota
  // B1:原子遞增(取代 read-modify-write,並行不覆蓋)
  await supabase.rpc("increment_quota", { p_source: "finmind", p_date: today, p_n: apiCalls });

  // 收尾 fetch_log
  await supabase.from("fetch_log").update({
    finished_at: new Date().toISOString(),
    success: errors.length === 0,
    rows_written: written,
    rows_skipped: skipped,
    error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null,
  }).eq("id", logId);

  return Response.json({
    target_symbols: targetSymbols.size,
    already_covered: alreadyCovered,
    api_calls: apiCalls,
    written,
    skipped,
    errors,
    quota: { used: usedSoFar + apiCalls, budget },
  });
});
