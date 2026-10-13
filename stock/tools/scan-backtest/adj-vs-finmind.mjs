// A2:官方調整事件(adj_events.json)vs 正式庫 stock_corporate_action(FinMind,現行只有靜態池有)。
//   唯讀 REST(讀 .env.local 的 SUPABASE_SERVICE_ROLE_KEY,不印出)。比對同一 symbol 的事件日與比例。
// usage: node adj-vs-finmind.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.join(here, "../../.env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error(".env.local 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const ca = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(`${SB}/rest/v1/stock_corporate_action?select=symbol,action_date,action_type,ratio&action_date=gte.2022-07-01&order=symbol,action_date`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` } });
  if (!r.ok) throw new Error(`REST ${r.status}`);
  const rows = await r.json();
  ca.push(...rows);
  if (rows.length < 1000) break;
}
const official = JSON.parse(fs.readFileSync(path.join(here, "adj_events.json"), "utf8"));
const lastDay = official.reduce((m, e) => (e[0] > m ? e[0] : m), "");
// FinMind 同日可能分 split / dividend 兩列 → 依 (symbol, date) 相乘
const fm = new Map();
for (const r of ca) {
  if (r.action_date > lastDay) continue;
  const k = `${r.symbol}|${r.action_date}`;
  fm.set(k, (fm.get(k) ?? 1) * Number(r.ratio));
}
const symbols = new Set([...fm.keys()].map((k) => k.split("|")[0]));
const off = new Map(official.filter((e) => symbols.has(e[1])).map((e) => [`${e[1]}|${e[0]}`, e[4]]));
let both = 0, close = 0;
const diffs = [], onlyFm = [], onlyOff = [];
for (const [k, r] of fm) {
  if (!off.has(k)) { onlyFm.push([k, r]); continue; }
  both++;
  const d = Math.abs(off.get(k) / r - 1);
  if (d < 0.002) close++; else diffs.push([k, r.toFixed(4), off.get(k).toFixed(4)]);
}
for (const [k, r] of off) if (!fm.has(k)) onlyOff.push([k, r.toFixed(4)]);
console.log({
  finmindRows: ca.length, finmindSymbols: symbols.size, finmindEvents: fm.size, officialEventsSameSymbols: off.size,
  matchedDate: both, ratioWithin0_2pct: close, ratioDiff: diffs.length, onlyFinmind: onlyFm.length, onlyOfficial: onlyOff.length,
  diffSample: diffs.slice(0, 8), onlyFinmindSample: onlyFm.slice(0, 8), onlyOfficialSample: onlyOff.slice(0, 8),
});
// 細分:FinMind 多出的是否都是 ETF / 4 碼以外;官方多出的是否落在該股 FinMind 資料起日之前
const isStock = (k) => /^[0-9]{4}\|/.test(k) || k.startsWith("0050|");
const fmStart = new Map();
for (const k of fm.keys()) { const [s, d] = k.split("|"); if (!fmStart.has(s) || d < fmStart.get(s)) fmStart.set(s, d); }
const onlyOffAfterStart = onlyOff.filter(([k]) => { const [s, d] = k.split("|"); return d >= fmStart.get(s); });
console.log({
  onlyFinmindStocks: onlyFm.filter(([k]) => isStock(k)).map(([k, r]) => `${k} ${r.toFixed(4)}`),
  onlyOfficialBeforeFinmindStart: onlyOff.length - onlyOffAfterStart.length,
  onlyOfficialAfterFinmindStart: onlyOffAfterStart.length,
  onlyOfficialAfterSample: onlyOffAfterStart.slice(0, 10).map(([k, r]) => `${k} ${r}`),
});
