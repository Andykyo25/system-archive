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
//   - quoted_at 用 tlong (毫秒 unix) 或 fallback to fetched_at
//
// 設計筆記:
// - L05:verify_jwt:true + 函式內 decode JWT role 驗證
// - L07:每次 invoke 寫 fetch_log
// - L11 例外:price_intraday_cache 是 cache,upsert 用 ON CONFLICT DO UPDATE

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MIS_BASE = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const REFERER = "https://mis.twse.com.tw/stock/";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BATCH_SIZE = 80;
const BATCH_THROTTLE_MS = 400;

interface MisQuote {
  c?: string;     // symbol
  ch?: string;    // channel "tse_2330.tw_"
  z?: string;     // 最新成交價(免費 mis 對個股有 throttle,常 "-")
  pz?: string;    // 前次成交價(也常被 throttle)
  y?: string;     // 昨日收盤
  o?: string;     // 開盤
  h?: string;     // 最高
  l?: string;     // 最低
  a?: string;     // 五檔賣盤 "p1_p2_p3_p4_p5_"(下劃線分隔,p1=最佳賣)
  b?: string;     // 五檔買盤 "p1_p2_p3_p4_p5_"(下劃線分隔,p1=最佳買)
  tv?: string;    // 本次成交量
  tlong?: string; // unix ms timestamp(mis 端時間,某些股 stuck)
  ex?: string;    // 'tse' or 'otc'
}

interface IntradayRow {
  symbol: string;
  quoted_at: string;
  price: number;
  volume: number | null;
  change_pct: number | null;
  market_state: string | null;
  currency: string | null;
  source: "twse_mis" | "twse_mis_mid";
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

function toN(v: unknown): number | null {
  if (v == null || v === "" || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchMisBatch(channels: string[]): Promise<{
  quotes: MisQuote[];
  fetchedAt: string;
  error?: string;
}> {
  const u = new URL(MIS_BASE);
  u.searchParams.set("ex_ch", channels.join("|"));
  u.searchParams.set("json", "1");
  u.searchParams.set("delay", "0");
  const fetchedAt = new Date().toISOString();

  const r = await fetch(u, {
    headers: {
      "Referer": REFERER,
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    },
  });
  if (!r.ok) return { quotes: [], fetchedAt, error: `HTTP ${r.status} ${r.statusText}` };
  const text = await r.text();
  let json: { msgArray?: unknown };
  try { json = JSON.parse(text); }
  catch { return { quotes: [], fetchedAt, error: `invalid json: ${text.slice(0, 100)}` }; }
  const arr = json.msgArray;
  if (!Array.isArray(arr)) return { quotes: [], fetchedAt, error: "no msgArray in response" };
  return { quotes: arr as MisQuote[], fetchedAt };
}

function quoteToRow(q: MisQuote, fallbackTs: string): IntradayRow | null {
  // Price 多源 fallback(v5,L47):
  //   問題:免費 mis 對個股 z 有 throttle,即使該股持續在成交(v 累積金額在跳),z/pz 仍長期回 "-"。
  //         L45 v4 寫「z="-" → skip」是邏輯對的(不偽造),但代價是 cache 對 6285/2330 這類常 z="-" 的股
  //         寫入頻率 = mis z 偶發回應頻率(20 min 1-5 次),user 看「16 min ago」。
  //   解法:用 mis 的五檔買賣盤 a/b(每 5-10 秒真更新)當 fallback。
  //     1. z 有真值 → 用 z(成交價,source="twse_mis")
  //     2. z="-" 但 a[0]/b[0] 有值 → 用五檔中價 (a[0]+b[0])/2(掛單反映即時,source="twse_mis_mid")
  //     3. z 跟 a/b 都 "-"(盤前/盤後/停牌) → skip 不寫
  //   時間軸:quoted_at 用 fetchedAt(EF 跑當下),不用 q.tlong。
  //     原因:q.tlong 對部分股 stuck(2454 z=3550 多次 query mis_t 都同個),用 fetchedAt 保證每分鐘 cron
  //           跑都寫新 row → user 看「1 min ago」即時度;**price 仍是 mis 真實值**(z 或五檔中價),
  //           只是時間軸用我們端,誠實標記 source。
  const z = toN(q.z);
  let price: number | null = null;
  let source: "twse_mis" | "twse_mis_mid";
  if (z != null && z > 0) {
    price = z;
    source = "twse_mis";
  } else {
    // 五檔買賣盤 "p1_p2_p3_p4_p5_"(下劃線分隔,p1=最佳),取最佳買 + 最佳賣中價
    const ask = toN((q.a ?? "").split("_")[0]);
    const bid = toN((q.b ?? "").split("_")[0]);
    if (ask != null && bid != null && ask > 0 && bid > 0) {
      price = (ask + bid) / 2;
      source = "twse_mis_mid";
    } else {
      return null; // 盤前/盤後/停牌等,a/b/z 全空 → skip
    }
  }
  if (price <= 0) return null;

  const prev = toN(q.y);
  const change_pct = (prev != null && prev > 0)
    ? ((price - prev) / prev) * 100
    : null;

  const symbol = q.c ?? "";
  if (!symbol) return null;

  return {
    symbol,
    quoted_at: fallbackTs, // EF 端 fetched_at,每分鐘 cron 寫新 row,不受 mis tlong stuck 影響
    price,
    volume: toN(q.tv),
    change_pct,
    market_state: "REGULAR", // 能寫入 cache 即真實在盤中(z 或 a/b 有值) → 必 REGULAR
    currency: "TWD",
    source,
  };
}

Deno.serve(async (req: Request) => {
  // L05:auth via JWT payload role
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return Response.json({ error: "missing bearer" }, { status: 401 });
  let role: unknown;
  try { role = decodeJwtPayload(auth.slice(7)).role; }
  catch { return Response.json({ error: "invalid jwt" }, { status: 401 }); }
  if (role !== "service_role") return Response.json({ error: "forbidden", role }, { status: 403 });

  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SERVICE_ROLE) return Response.json({ error: "missing SUPABASE_SERVICE_ROLE_KEY env" }, { status: 500 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);

  // 收集 target symbol + market
  // - stock_universe(已有 market 欄位):權威來源
  // - holdings_transactions / watchlist / industry_stocks / etf_metadata:無 market → default 'twse'
  // - 若 symbol 同時出現在 universe 跟其他表,以 universe 為準
  const [universe, holdings, txn, watchlist, industry, etf] = await Promise.all([
    supabase.from("stock_universe").select("symbol, market"),
    supabase.from("holdings").select("symbol").is("closed_at", null),
    supabase.from("holdings_transactions").select("symbol"),
    supabase.from("watchlist").select("symbol"),
    supabase.from("industry_stocks").select("symbol"),
    supabase.from("etf_metadata").select("symbol"),
  ]);

  const symbolToMarket = new Map<string, string>();
  for (const r of universe.data ?? []) {
    symbolToMarket.set(r.symbol, (r.market ?? "twse").toLowerCase());
  }
  const addIfMissing = (sym: string) => {
    if (!symbolToMarket.has(sym)) symbolToMarket.set(sym, "twse");
  };
  for (const r of holdings.data ?? []) addIfMissing(r.symbol);
  for (const r of txn.data ?? []) addIfMissing(r.symbol);
  for (const r of watchlist.data ?? []) addIfMissing(r.symbol);
  for (const r of industry.data ?? []) addIfMissing(r.symbol);
  for (const r of etf.data ?? []) addIfMissing(r.symbol);

  if (symbolToMarket.size === 0) {
    return Response.json({ skipped: "no_target_symbols" });
  }

  // build channels: tse_X.tw or otc_X.tw
  const channels: string[] = [];
  for (const [sym, mkt] of symbolToMarket) {
    const prefix = mkt === "tpex" || mkt === "otc" ? "otc" : "tse";
    channels.push(`${prefix}_${sym}.tw`);
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

  const missingSymbols = Array.from(symbolToMarket.keys()).filter((s) => !seenSymbols.has(s));

  // L11 例外:price_intraday_cache 即時 cache → ON CONFLICT DO UPDATE
  let written = 0;
  let writeError: string | null = null;
  if (allRows.length > 0) {
    const { data, error } = await supabase
      .from("price_intraday_cache")
      .upsert(allRows, { onConflict: "symbol,quoted_at", ignoreDuplicates: false })
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
