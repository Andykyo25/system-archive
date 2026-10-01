// 盤中即時分析(命令列版):與網頁 /intraday 共用 lib/intraday.ts 的分析邏輯,只負責取資料與輸出文字。
// usage: node tools/intraday/snapshot.mjs <symbol> [--no-save]
// 需要 Node ≥ 22.18(原生載入 .ts);較舊的 22.x 請加 --experimental-strip-types。
// 資料來源:TWSE MIS 即時揭示 + Supabase price_daily / v_holdings_current / v_verdict_live / app_settings
//   (讀 .env.local 的 SUPABASE_SERVICE_ROLE_KEY,不印出)。
// 快照存 tools/intraday/snapshots/<symbol>.jsonl(本機,已 gitignore),下次執行與本日上一次比對。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  adviceText, compareReadings, dailyStats, fmt, pctText, staticReadings, supplyAbove, taipeiHM, taipeiYmd, toQuote, toSnapshot,
} from "../../lib/intraday.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const [symbol, ...flags] = process.argv.slice(2);
if (!symbol || !/^[0-9A-Z]{4,6}$/.test(symbol)) {
  console.error("usage: node tools/intraday/snapshot.mjs <symbol> [--no-save]");
  process.exit(1);
}

const env = {};
for (const line of fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error(".env.local 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const rest = async (table, query) => {
  const r = await fetch(`${SB}/rest/v1/${table}?${query}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`${table} HTTP ${r.status}`);
  return r.json();
};
const n = (v) => { if (v == null || v === "") return null; const x = Number(v); return Number.isFinite(x) ? x : null; };

// MIS 連線偶爾被重置,重試最多 3 次
async function fetchMis(sym) {
  const u = new URL("https://mis.twse.com.tw/stock/api/getStockInfo.jsp");
  u.searchParams.set("ex_ch", `tse_${sym}.tw|otc_${sym}.tw`);
  u.searchParams.set("json", "1");
  u.searchParams.set("delay", "0");
  let err;
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(u, { headers: { Referer: "https://mis.twse.com.tw/stock/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36" } });
      if (!r.ok) throw new Error(`MIS HTTP ${r.status}`);
      return ((await r.json()).msgArray ?? []).find((x) => x.c === sym) ?? null;
    } catch (e) { err = e; await new Promise((res) => setTimeout(res, 400 * i)); }
  }
  throw err;
}

// Windows 上 fetch 連線未關時 process.exit 會觸發 libuv assertion → 失敗一律 throw Fail,讓程序自然結束
class Fail extends Error {}
const fail = (msg) => { console.error(msg); process.exitCode = 1; throw new Fail(msg); };

async function run() {
const raw = await fetchMis(symbol).catch((e) => { console.error(`MIS 連線失敗:${e.message}`); return null; });
if (!raw) fail(`MIS 查無 ${symbol}(代號錯誤、非交易時段或連線失敗)`);

const [barsR, verdictR, holdR, setR] = await Promise.all([
  rest("price_daily", `symbol=eq.${symbol}&select=trade_date,high,low,close,volume,adj_factor&order=trade_date.desc&limit=130&close=gt.0`),
  rest("v_verdict_live", `symbol=eq.${symbol}&select=watch_date,entry_min,entry_max,stop_price,state,reason&limit=1`),
  rest("v_holdings_current", `symbol=eq.${symbol}&select=net_qty,avg_cost&limit=1`),
  rest("app_settings", "key=eq.atr_stop_multiple&select=value"),
]);
const bars = barsR.reverse().map((b) => ({ d: b.trade_date, h: n(b.high), l: n(b.low), c: Number(b.close), v: n(b.volume), f: n(b.adj_factor) ?? 1 }));
const quote = toQuote(raw);
const price = quote?.price ?? null;
const v = verdictR[0], h = holdR[0];
const a = {
  symbol, name: raw.n ?? null, fetchedAt: Date.now(), quote, quoteError: quote ? null : "MIS 無可用報價", fallback: null,
  daily: dailyStats(bars), supply: price != null && bars.length ? supplyAbove(bars, price) : null,
  verdict: v ? { watchDate: v.watch_date, entryMin: n(v.entry_min), entryMax: n(v.entry_max), stopPrice: n(v.stop_price), state: v.state, reason: v.reason ?? null } : null,
  holding: h && n(h.net_qty) > 0 ? { lots: n(h.net_qty) / 1000, avgCost: Number(h.avg_cost) } : null,
  atrMultiple: n(setR[0]?.value) ?? 2,
};
const cur = toSnapshot(a);
if (!cur) fail("無可用價格");

// 本日上一次快照
const snapDir = path.join(here, "snapshots"), snapFile = path.join(snapDir, `${symbol}.jsonl`);
const before = fs.existsSync(snapFile)
  ? fs.readFileSync(snapFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => taipeiYmd(r.t) === taipeiYmd(cur.t) && r.t < cur.t).pop() ?? null
  : null;

// ---- 輸出 ----
const q = quote;
const lag = q.quotedAt && cur.t - q.quotedAt > 90e3 ? `  ※報價時間 ${taipeiHM(q.quotedAt)},落後 ${Math.round((cur.t - q.quotedAt) / 60000)} 分鐘(盤後或揭示延遲)` : "";
const out = [`${symbol} ${a.name ?? ""} ${taipeiHM(cur.t)} 更新${before ? `(上次 ${taipeiHM(before.t)})` : "(本日首次快照)"}${lag}`, "", "最新盤面"];
const cell = (s) => `${fmt(s.price)}(${pctText(s.chgPct)})`;
out.push(`項目       ${before ? taipeiHM(before.t).padEnd(18) : ""}${taipeiHM(cur.t)}`);
out.push(`現價       ${before ? cell(before).padEnd(16) : ""}${cell(cur)}${q.priceIsMid ? "  ※無成交價,以五檔中價代替" : ""}`);
out.push(`今日高/低  ${before ? `${fmt(before.hi)} / ${fmt(before.lo)}`.padEnd(18) : ""}${fmt(cur.hi)} / ${fmt(cur.lo)}`);
out.push(`成交量(張) ${before ? String(before.vol).padEnd(18) : ""}${cur.vol}`);
out.push("", "五檔掛單");
out.push(`- 委賣:${[...q.ask].reverse().map((l) => `${fmt(l.price)}×${l.lots}`).join("  ")}(合計 ${q.askTot} 張)`);
out.push(`- 委買:${q.bid.map((l) => `${fmt(l.price)}×${l.lots}`).join("  ")}(合計 ${q.bidTot} 張)`);
out.push("", "解讀");
for (const r of [...compareReadings(cur, before), ...staticReadings(a)]) out.push(`- ${r.text}`);
const t = adviceText(a);
out.push("", "操作參考(既有系統規則換算,非新訊號)", `- 沒有持股:${t.flat}`, `- ${t.heldLabel}:${t.held.join(";")}`);
console.log(out.join("\n"));

if (!flags.includes("--no-save")) {
  fs.mkdirSync(snapDir, { recursive: true });
  fs.appendFileSync(snapFile, JSON.stringify(cur) + "\n");
}
}

try { await run(); } catch (e) { if (!(e instanceof Fail)) throw e; }
