// fetch-yahoo-intraday(實際用 TWSE MIS 即時揭示)
//
// Yahoo Finance public quote API 2024 起需 cookie+crumb auth,server-to-server 不穩。
// 改用 TWSE 公開即時揭示 endpoint:
//   https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=<channels>&json=1&delay=0
// 需帶 Referer: https://mis.twse.com.tw/stock/(必填,否則 403)
// 上市 channel: tse_<symbol>.tw
// 上櫃 channel: otc_<symbol>.tw
// 一次最多 ~100 個 channel,3-5 秒延遲,免費免註冊
//
// 名稱保留 fetch-yahoo-intraday(已有 cron 排程),功能上是 TWSE MIS。
//
// 寫入 price_intraday_cache:
//   - source 改為 'twse_mis'(view 已動態化吃 source 欄位,migration 24)
//   - quoted_at 只用有效 tlong (毫秒 unix)，不可用抓取時間掩蓋舊報價
//
// 設計筆記:
// - L05:verify_jwt:true + 函式內比對可信 service/cron secret
// - L07:每次 invoke 寫 fetch_log
// - L11 例外:price_intraday_cache 是 cache,upsert 用 ON CONFLICT DO UPDATE

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { authorizeServiceRequest } from "../_shared/authorize.ts";
import { deduplicateQuotes, quoteToRow, type IntradayRow, type MisQuote } from "./quote.ts";

const MIS_BASE = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const REFERER = "https://mis.twse.com.tw/stock/";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BATCH_SIZE = 80;
const BATCH_THROTTLE_MS = 400;

async function fetchMisBatch(channels: string[]): Promise<{
  quotes: MisQuote[];
  fetchedAt: string;
  error?: string;
}> {
  const u = new URL(MIS_BASE);
  u.searchParams.set("ex_ch", channels.join("|"));
  u.searchParams.set("json", "1");
  u.searchParams.set("delay", "0");

  const r = await fetch(u, {
    headers: {
      "Referer": REFERER,
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    },
  });
  if (!r.ok) return { quotes: [], fetchedAt: new Date().toISOString(), error: `HTTP ${r.status} ${r.statusText}` };
  const text = await r.text();
  const fetchedAt = new Date().toISOString(); // response receipt, only for validating provider time
  let json: { msgArray?: unknown };
  try { json = JSON.parse(text); }
  catch { return { quotes: [], fetchedAt, error: `invalid json: ${text.slice(0, 100)}` }; }
  const arr = json.msgArray;
  if (!Array.isArray(arr)) return { quotes: [], fetchedAt, error: "no msgArray in response" };
  return { quotes: arr as MisQuote[], fetchedAt };
}

Deno.serve(async (req: Request) => {
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SERVICE_ROLE) return Response.json({ error: "missing SUPABASE_SERVICE_ROLE_KEY env" }, { status: 500 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);
  const authorized = await authorizeServiceRequest(req, SERVICE_ROLE, async () => {
    const { data, error } = await supabase.rpc("read_edge_function_auth");
    if (error) return null;
    return typeof data === "string" ? data : null;
  });
  if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });

  // 收集 target symbol + market
  // - stock_universe(已有 market 欄位):權威來源
  // - v_holdings_current(當前持股)/ watchlist / industry / etf:無 market → default 'twse'
  // - 若 symbol 同時出現在 universe 跟其他表,以 universe 為準
  // B2:持股改讀 v_holdings_current(當前淨持股)取代舊 holdings 表 + holdings_transactions
  //   (後者含已平倉,過度收料;且舊 holdings 表可能與 v_holdings_current 不一致)
  const [universe, holdingsCurrent, watchlist, industry, etf] = await Promise.all([
    supabase.from("stock_universe").select("symbol, market"),
    supabase.from("v_holdings_current").select("symbol"),
    supabase.from("watchlist").select("symbol"),
    supabase.from("industry_stocks").select("symbol"),
    supabase.from("etf_metadata").select("symbol"),
  ]);

  const symbolToMarket = new Map<string, string>();
  for (const r of universe.data ?? []) {
    symbolToMarket.set(r.symbol, (r.market ?? "twse").toLowerCase());
  }
  // v6(2026-07-17):universe 外的 symbol(純持股/watchlist)market 未知,舊版預設 'twse'
  //   → 上櫃持股(6207 案例)被組成無效 channel tse_6207.tw,intraday cache 永遠零筆。
  //   改標 'unknown' → 下方同時掛 tse_ + otc_ 雙 channel:MIS 對無效 channel 回空殼
  //   (c 欄空,quoteToRow 安全 skip,2026-07-17 實證),有效那個自然進 cache。
  const addIfMissing = (sym: string) => {
    if (!symbolToMarket.has(sym)) symbolToMarket.set(sym, "unknown");
  };
  // B2:持股優先 add(v_holdings_current);fallback view 異常退回舊 holdings 表(零退化)
  if (holdingsCurrent.error) {
    const { data: oldH } = await supabase.from("holdings").select("symbol").is("closed_at", null);
    for (const r of oldH ?? []) addIfMissing(r.symbol);
  } else {
    for (const r of holdingsCurrent.data ?? []) addIfMissing(r.symbol);
  }
  for (const r of watchlist.data ?? []) addIfMissing(r.symbol);
  for (const r of industry.data ?? []) addIfMissing(r.symbol);
  for (const r of etf.data ?? []) addIfMissing(r.symbol);

  if (symbolToMarket.size === 0) {
    return Response.json({ skipped: "no_target_symbols" });
  }

  // build channels: tse_X.tw or otc_X.tw;market unknown → 兩個都掛(無效者回空殼)
  const channels: string[] = [];
  for (const [sym, mkt] of symbolToMarket) {
    if (mkt === "tpex" || mkt === "otc") channels.push(`otc_${sym}.tw`);
    else if (mkt === "unknown") channels.push(`tse_${sym}.tw`, `otc_${sym}.tw`);
    else channels.push(`tse_${sym}.tw`);
  }
  channels.sort();

  // open fetch_log
  const { data: logRow, error: logErr } = await supabase
    .from("fetch_log").insert({ source: "twse_mis_intraday" }).select("id").single();
  if (logErr) return Response.json({ error: "fetch_log insert", detail: logErr.message }, { status: 500 });
  const logId = logRow.id;

  const allRows: IntradayRow[] = [];
  const batchErrors: string[] = [];
  const seenSymbols = new Set<string>();

  for (let i = 0; i < channels.length; i += BATCH_SIZE) {
    const batch = channels.slice(i, i + BATCH_SIZE);
    try {
      const { quotes, fetchedAt, error } = await fetchMisBatch(batch);
      if (error) {
        batchErrors.push(`batch ${i / BATCH_SIZE + 1}: ${error}`);
        continue;
      }
      for (const q of quotes) {
        const row = quoteToRow(q, fetchedAt);
        if (row) { allRows.push(row); seenSymbols.add(row.symbol); }
      }
    } catch (e) {
      batchErrors.push(`batch ${i / BATCH_SIZE + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (i + BATCH_SIZE < channels.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_THROTTLE_MS));
    }
  }

  const uniqueRows = deduplicateQuotes(allRows);
  const missingSymbols = Array.from(symbolToMarket.keys()).filter((s) => !seenSymbols.has(s));

  // L11 例外:price_intraday_cache 即時 cache → ON CONFLICT DO UPDATE
  let written = 0;
  let writeError: string | null = null;
  if (uniqueRows.length > 0) {
    const { data, error } = await supabase
      .from("price_intraday_cache")
      .upsert(uniqueRows, { onConflict: "symbol,quoted_at", ignoreDuplicates: false })
      .select("symbol");
    if (error) writeError = error.message;
    else written = data?.length ?? 0;
  }

  const success = batchErrors.length === 0 && writeError === null;
  const errSummary = [
    ...(writeError ? [`write: ${writeError}`] : []),
    ...batchErrors,
  ].join("; ").slice(0, 1000) || null;

  await supabase.from("fetch_log").update({
    finished_at: new Date().toISOString(),
    success,
    rows_written: written,
    error: errSummary,
  }).eq("id", logId);

  return Response.json({
    target_symbols: symbolToMarket.size,
    channels: channels.length,
    batches: Math.ceil(channels.length / BATCH_SIZE),
    quotes_received: allRows.length,
    missing_symbols: missingSymbols.slice(0, 20),
    missing_count: missingSymbols.length,
    written,
    batch_errors: batchErrors,
    write_error: writeError,
  });
});
