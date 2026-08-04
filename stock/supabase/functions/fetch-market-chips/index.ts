import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// 大盤籌碼日表 fetcher — M10 Phase 1(2026-08-04)。
//
// 一次抓三個 FinMind 市場層級 dataset,寫成 market_chips_daily 一天一列:
//   TaiwanFuturesInstitutionalInvestors (TX) → 外資/投信/自營 台指期未平倉(留倉)
//   TaiwanStockTotalMarginPurchaseShortSale  → 全市場融資/融券餘額
//   TaiwanStockTotalInstitutionalInvestors   → 全市場三大法人買賣超金額
//
// 三個 dataset 都是「每天 1 call 抓一段 range」,不是逐檔迴圈 → 即使 backfill 兩年
// 也只花 3 個 call,不會擠壓已經吃緊的 finmind token quota(L55)。免 token 可打,
// 但仍保留 FINMIND_TOKEN env:若未來免費層被關,補 env 即可,不必改 code。
//
// 模式:預設抓近 14 個日曆日(cron 收盤後跑,容錯連假);backfill 傳 body.start_date。
//
// 寫入策略:三個 dataset 各自獨立 upsert,只帶自己的欄位。PostgREST 的
// merge-duplicates 只更新 payload 內的 column,故某個 dataset 掛掉時
// 不會把另外兩個已寫好的欄位洗成 null(L45:真實值不存在就別寫,不 fallback 造假)。

const FINMIND = "https://api.finmindtrade.com/api/v4/data";

// FinMind 的法人別名是中文字串,且在執行路徑上(比對用)。依 L49 一律以 \u 碼點
// 表示,讓整個執行路徑保持純 ASCII —— 中文只要進了執行路徑,手寫誤植就是靜默錯配。
// 碼點由實際 API 回應機械導出(node 掃 institutional_investors 去重),非手打。
const INV_FOREIGN = "\u5916\u8cc7"; // 外資
const INV_TRUST = "\u6295\u4fe1"; // 投信
const INV_DEALER = "\u81ea\u71df\u5546"; // 自營商

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

function taipeiToday(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysAgo(from: string, n: number): string {
  const d = new Date(from + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

interface FinMindRow {
  date: string;
  [k: string]: unknown;
}

async function finmind(
  dataset: string,
  start: string,
  end: string,
  dataId?: string,
): Promise<FinMindRow[]> {
  const u = new URL(FINMIND);
  u.searchParams.set("dataset", dataset);
  if (dataId) u.searchParams.set("data_id", dataId);
  u.searchParams.set("start_date", start);
  u.searchParams.set("end_date", end);
  const token = Deno.env.get("FINMIND_TOKEN");
  if (token) u.searchParams.set("token", token);

  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j?.status !== 200) throw new Error(`finmind: ${j?.msg ?? "unknown"}`);
  return (j.data ?? []) as FinMindRow[];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// 台指期三大法人未平倉 → 每個交易日一列。net = 多方留倉 - 空方留倉。
function mapFutures(rows: FinMindRow[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const long = num(r.long_open_interest_balance_volume);
    const short = num(r.short_open_interest_balance_volume);
    if (long == null || short == null) continue;
    const cur = out.get(r.date) ?? { trade_date: r.date };
    const who = r.institutional_investors;
    if (who === INV_FOREIGN) {
      cur.fut_foreign_oi_long = long;
      cur.fut_foreign_oi_short = short;
      cur.fut_foreign_oi_net = long - short;
    } else if (who === INV_TRUST) {
      cur.fut_trust_oi_net = long - short;
    } else if (who === INV_DEALER) {
      cur.fut_dealer_oi_net = long - short;
    }
    out.set(r.date, cur);
  }
  return out;
}

// 全市場融資融券:long format,name 區分 MarginPurchase(張)/MarginPurchaseMoney(元)/ShortSale(張)。
function mapMargin(rows: FinMindRow[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const bal = num(r.TodayBalance);
    if (bal == null) continue;
    const cur = out.get(r.date) ?? { trade_date: r.date };
    if (r.name === "MarginPurchase") cur.margin_balance_shares = bal;
    else if (r.name === "MarginPurchaseMoney") cur.margin_balance_amount = bal;
    else if (r.name === "ShortSale") cur.short_balance_shares = bal;
    out.set(r.date, cur);
  }
  return out;
}

// 全市場三大法人買賣超金額(元)。Foreign_Investor 為外資(不含外資自營)。
function mapTotalInst(rows: FinMindRow[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const buy = num(r.buy);
    const sell = num(r.sell);
    if (buy == null || sell == null) continue;
    const cur = out.get(r.date) ?? { trade_date: r.date };
    if (r.name === "Foreign_Investor") cur.foreign_net_buy = buy - sell;
    else if (r.name === "Investment_Trust") cur.trust_net_buy = buy - sell;
    out.set(r.date, cur);
  }
  return out;
}

Deno.serve(async (req: Request) => {
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

  let body: { start_date?: string; end_date?: string } = {};
  try {
    body = await req.json();
  } catch { /* no body ok */ }
  const end = body.end_date ?? taipeiToday();
  const start = body.start_date ?? daysAgo(end, 14);

  const { data: logRow } = await supabase
    .from("fetch_log").insert({ source: "market_chips" }).select("id").single();
  const logId = logRow!.id;

  const sources: {
    key: string;
    dataset: string;
    dataId?: string;
    map: (r: FinMindRow[]) => Map<string, Record<string, unknown>>;
  }[] = [
    {
      key: "futures",
      dataset: "TaiwanFuturesInstitutionalInvestors",
      dataId: "TX",
      map: mapFutures,
    },
    {
      key: "margin",
      dataset: "TaiwanStockTotalMarginPurchaseShortSale",
      map: mapMargin,
    },
    {
      key: "total_inst",
      dataset: "TaiwanStockTotalInstitutionalInvestors",
      map: mapTotalInst,
    },
  ];

  let written = 0;
  const errors: string[] = [];
  const perSource: Record<string, number> = {};

  for (const s of sources) {
    try {
      const raw = await finmind(s.dataset, start, end, s.dataId);
      const rows = [...s.map(raw).values()];
      perSource[s.key] = rows.length;
      if (rows.length > 0) {
        // 只帶自己的欄位 upsert,不碰其他 dataset 已寫入的 column。
        const { error } = await supabase
          .from("market_chips_daily")
          .upsert(rows, { onConflict: "trade_date" });
        if (error) throw error;
        written += rows.length;
      }
    } catch (e) {
      // supabase-js 的錯誤物件 String() 會變 [object Object](L54),故先取 message。
      const msg = e instanceof Error
        ? e.message
        : typeof e === "object" && e !== null
        ? JSON.stringify(e)
        : String(e);
      perSource[s.key] = -1;
      errors.push(`${s.key}: ${msg}`);
    }
  }

  await supabase.from("fetch_log").update({
    finished_at: new Date().toISOString(),
    success: errors.length === 0,
    rows_written: written,
    error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null,
  }).eq("id", logId);

  return Response.json({
    range: { start, end },
    per_source: perSource,
    written,
    errors: errors.length,
    error_detail: errors.slice(0, 5),
  });
});
