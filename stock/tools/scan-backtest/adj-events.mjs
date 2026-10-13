// 除權息 / 減資等價格調整事件稽核。
//   舊法(engine.mjs 原本):ref = 收盤 − 漲跌;但兩市場除權息日的漲跌是 X / 「除息」文字 → 等於沒還原。
//   新法:官方除權息計算結果表(fetch-exright.mjs)的「除權息前收盤價 / 參考價」→ ratio = ref / prev。
// 輸出 adj_events.json([iso, sym, prev, ref, ratio, mkt, source])與稽核摘要;不寫正式庫。
// usage: node adj-events.mjs
import fs from "node:fs";
import { auditOfficial, buildEvents, resumeEvents } from "./adj-events-lib.mjs";

const DIR = "data";
const days = new Map();
const official = [];
for (const f of fs.readdirSync(DIR)) {
  let m = f.match(/^(twse|tpex)_(\d{8})\.json$/);
  if (m) {
    const iso = `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`;
    if (!days.has(iso)) days.set(iso, {});
    days.get(iso)[m[1]] = JSON.parse(fs.readFileSync(`${DIR}/${f}`, "utf8")).rows;
    continue;
  }
  m = f.match(/^(exright|capred|parval)_(twse|tpex)_\d{6}\.json$/);
  if (m) for (const r of JSON.parse(fs.readFileSync(`${DIR}/${f}`, "utf8"))) official.push([...r, m[2], m[1]]);
}
const legacy = buildEvents(days).stats;
const audit = auditOfficial(days, official.map((r) => r.slice(0, 4)));
// 停牌後復牌的分割(0050 / 0052 / 櫃買面額變更):官方三張表沒有,用交易所當日相對參考價的漲跌補
const resumed = resumeEvents(days, new Set(official.map((r) => `${r[1]}|${r[0]}`)));
// 第 7 欄 = 來源:exright(除權息)/ capred(減資)/ parval(面額變更)/ resume(停牌後復牌的分割)
const events = [...official, ...resumed.map((r) => [...r, "resume"])]
  .map(([d, sym, prev, ref, mkt, src]) => [d, sym, prev, ref, ref / prev, mkt, src])
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
fs.writeFileSync("adj_events.json", JSON.stringify(events));
console.log({ legacy, official: audit.stats, resume: resumed.map((r) => `${r[0]} ${r[1]} ${(r[3] / r[2]).toFixed(4)}`), mismatchSample: audit.mismatches, unexplainedSample: audit.unexplained.slice(0, 15) });
