import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// 全市場歷史日線 backfill — M12(2026-08-06)
//
// 問題:全市場價格 2026-07-02 才開始收(1785 檔同日進場),至今僅約 24 個交易日。
// v_breakout_scan 的「突破前 20 日高 + 月線轉揚」需要 20 根以上,上櫃因 8/04 缺料
// 平均只有 19.1 根 → 871 檔上櫃僅 33 檔可判斷。沒有歷史,型態條件形同虛設。
//
// 既有 fetch-daily-prices 用的是「當日」端點,無法指定日期。本 EF 改用兩個
// **按日歷史**端點(2026-08-06 實測):
//   TWSE  MI_INDEX?date=YYYYMMDD&type=ALL      → 31267 列,4 位數代號 1094 檔
//   TPEx  otc?date=民國YYY/MM/DD&type=EW       → 1012 列,4 位數代號 888 檔
//                                                (關鍵是 type=EW,少了它 totalCount=0)
// 兩市場各 1 call/日 → 90 天 = 180 calls,且不吃 FinMind quota。
//
// 寫入用 ignoreDuplicates:既有資料一律不覆蓋(當日收料寫的才是第一手,
// 事後補的可能含事後修正)。本 EF 只填洞,不改寫歷史。
//
// 單次天數上限(預設 12)避免 EF timeout;回傳 next_start 供分批續跑。

const TWSE = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX";
const TPEX = "https://www.tpex.org.tw/www/zh-tw/afterTrading/otc";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface PriceRow {
  symbol: string;
  trade_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  source: string;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

// "121,774,200" -> 121774200 ; "--" / "" -> null
function num(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).replace(/,/g, "").trim();
  if (!s || s === "--" || s === "---") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const isStock = (s: string) => /^[0-9]{4}$/.test(s.trim());

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function compact(d: Date): string {
  return ymd(d).replace(/-/g, "");
}
// 2026-08-04 -> 115/08/04
function rocSlash(d: Date): string {
  const iso = ymd(d);
  const y = Number(iso.slice(0, 4)) - 1911;
  return `${y}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

// 上游(尤其 tpex)會偶發 Cloudflare 520 與大回應截斷 —— 2026-08-05/06/07/10 連四天
// `tpex HTTP 520`,但同一時間本機直打同一支端點是 200/139KB。也就是說 520 不是端點壞掉,
// 是邊緣節點對這條連線的瞬時拒絕,重試就會過。3 次嘗試、間隔遞增。
//
// ⚠ 這裡刻意**不用** fetch-daily-prices 那套「先收 text 再 parse」:
// TWSE MI_INDEX type=ALL 單日 31267 列,text 與 parse 後的物件同時在記憶體裡會翻倍,
// 5 天一輪直接 WORKER_RESOURCE_LIMIT(2026-08-11 實測撞到)。
// 而且「body 消耗掉就不能重試」只在同一個 response 內成立 —— 重試是重發請求、拿到
// 新的 response,所以 res.json() 一樣重試得了,還省一份記憶體。
async function fetchJson(url: string, tag: string): Promise<unknown> {
  let lastErr = new Error("unreachable");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error(`${tag} HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(`${tag}: ${String(e)}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastErr;
}

async function fetchTWSE(d: Date): Promise<PriceRow[]> {
  const url = `${TWSE}?date=${compact(d)}&type=ALL&response=json`;
  // deno-lint-ignore no-explicit-any
  const j = await fetchJson(url, "twse") as any;
  if (j?.stat !== "OK") return [];
  // 挑列數最多的 table(= 每日收盤行情全部),用結構判斷不靠中文標題比對
  const tables: { fields?: string[]; data?: unknown[][] }[] = j.tables ?? [];
  let best: unknown[][] = [];
  for (const t of tables) {
    const rows = t.data ?? [];
    if (rows.length > best.length) best = rows;
  }
  const out: PriceRow[] = [];
  for (const r of best) {
    const sym = String(r[0] ?? "").trim();
    if (!isStock(sym)) continue;
    const close = num(r[8]);
    if (close == null || close <= 0) continue;
    out.push({
      symbol: sym,
      trade_date: ymd(d),
      open: num(r[5]),
      high: num(r[6]),
      low: num(r[7]),
      close,
      volume: num(r[2]),
      source: "twse",
    });
  }
  return out;
}

async function fetchTPEX(d: Date): Promise<PriceRow[]> {
  const url = `${TPEX}?date=${encodeURIComponent(rocSlash(d))}&type=EW&response=json`;
  // deno-lint-ignore no-explicit-any
  const j = await fetchJson(url, "tpex") as any;
  const t = (j?.tables ?? [])[0];
  const rows: unknown[][] = t?.data ?? [];
  const out: PriceRow[] = [];
  for (const r of rows) {
    const sym = String(r[0] ?? "").trim();
    if (!isStock(sym)) continue;
    const close = num(r[2]);
    if (close == null || close <= 0) continue;
    out.push({
      symbol: sym,
      trade_date: ymd(d),
      open: num(r[4]),
      high: num(r[5]),
      low: num(r[6]),
      close,
      volume: num(r[7]),
      source: "tpex",
    });
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

  let body: { start_date?: string; end_date?: string; max_days?: number } = {};
  try {
    body = await req.json();
  } catch { /* no body ok */ }
  if (!body.start_date || !body.end_date) {
    return Response.json({ error: "start_date and end_date required" }, { status: 400 });
  }
  const maxDays = Math.min(body.max_days ?? 12, 30);

  const { data: logRow } = await supabase
    .from("fetch_log").insert({ source: "backfill_market_history" }).select("id").single();
  const logId = logRow!.id;

  const start = new Date(body.start_date + "T00:00:00Z");
  const end = new Date(body.end_date + "T00:00:00Z");

  let written = 0;
  let processed = 0;
  const errors: string[] = [];
  const perDay: Record<string, number> = {};
  let cursor = new Date(start);
  let nextStart: string | null = null;

  while (cursor <= end) {
    if (processed >= maxDays) {
      nextStart = ymd(cursor);
      break;
    }
    const dow = cursor.getUTCDay();
    if (dow === 0 || dow === 6) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      continue;
    }
    const dayKey = ymd(cursor);
    let dayRows: PriceRow[] = [];
    for (const [name, fn] of [["twse", fetchTWSE], ["tpex", fetchTPEX]] as const) {
      try {
        dayRows = dayRows.concat(await fn(cursor));
      } catch (e) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        errors.push(`${dayKey} ${name}: ${msg}`);
      }
    }
    if (dayRows.length > 0) {
      for (let i = 0; i < dayRows.length; i += 500) {
        const chunk = dayRows.slice(i, i + 500);
        const { error } = await supabase
          .from("price_daily")
          .upsert(chunk, { onConflict: "symbol,trade_date", ignoreDuplicates: true });
        if (error) {
          errors.push(`${dayKey} upsert: ${error.message}`);
          break;
        }
        written += chunk.length;
      }
    }
    perDay[dayKey] = dayRows.length;
    processed++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  await supabase.from("fetch_log").update({
    finished_at: new Date().toISOString(),
    success: errors.length === 0,
    rows_written: written,
    error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null,
  }).eq("id", logId);

  return Response.json({
    range: { start: body.start_date, end: body.end_date },
    days_processed: processed,
    rows_upserted: written,
    next_start: nextStart,
    per_day: perDay,
    errors: errors.length,
    error_detail: errors.slice(0, 5),
  });
});
