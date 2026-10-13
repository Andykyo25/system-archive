// R2p 上線規格在三種價格基準下的比較(2026-10-13 全市場還原權值重驗)。
//   legacy = 原 engine(除權息日實際未還原)、nodiv = 只還原分割 / 減資 / 面額變更、official = 全部還原(含股利)
// 選股與出場與 r2p.mjs 完全相同;另算按日加權(L75)與名單重疊。先跑 engine.mjs 產生 signals_{mode}.json。
// usage: node adj-compare.mjs
import fs from "node:fs";
import { stats, dstats, sim, IS, OOS } from "./lib.mjs";

const MODES = ["legacy", "nodiv", "official"];
const ys = ["2023", "2024", "2025", "2026"];
const stopOf = (s) => 1 - (3 * s.atrPct) / 100;
const pass = (s) => s.score >= 80 && s.offHi60 > -5 && s.supply90 <= 0.1 && s.e50_ma60 > 0;
const ret = (s) => sim(s, { H: 20, tp: 10, stop: stopOf(s) });
const f = (x) => (x == null ? "    -" : x.toFixed(1).padStart(5));

const run = {};
for (const m of MODES) {
  const sig = JSON.parse(fs.readFileSync(`signals_${m}.json`, "utf8"));
  const byD = new Map();
  for (const s of sig.filter(pass)) { if (!byD.has(s.d)) byD.set(s.d, []); byD.get(s.d).push(s); }
  const listed = [...byD.values()].flatMap((a) => a.sort((x, y) => y.score - x.score || y.dayPct - x.dayPct).slice(0, 3));
  const traded = listed.filter((s) => s.path?.length >= 20 && s.l1 != null && 1 + s.l1 / 100 > stopOf(s));
  run[m] = { listed, traded };
  const st = stats(traded, ret), d = dstats(traded, ret), di = dstats(traded.filter(IS), ret), dO = dstats(traded.filter(OOS), ret);
  console.log(`${m.padEnd(8)} traded ${String(traded.length).padStart(4)} | pooled win ${f(st.win)} meanNet ${f(st.mean)} pf ${st.pf.toFixed(2)}`
    + ` | daily win ${f(d.dwin)} meanNet ${f(d.dmean)} IS ${f(di.dwin)}/${f(di.dmean)} OOS ${f(dO.dwin)}/${f(dO.dmean)}`
    + ` | daily win by year ${ys.map((y) => f(dstats(traded.filter((s) => s.d.startsWith(y)), ret).dwin)).join("")}`);
}
const key = (s) => `${s.d}|${s.sym}`;
for (const [a, b] of [["legacy", "official"], ["nodiv", "official"], ["legacy", "nodiv"]]) {
  const A = new Set(run[a].listed.map(key)), B = new Set(run[b].listed.map(key));
  const both = [...A].filter((k) => B.has(k)).length;
  const days = new Set([...A, ...B].map((k) => k.slice(0, 10)));
  const same = [...days].filter((d) => {
    const x = run[a].listed.filter((s) => s.d === d).map((s) => s.sym).sort().join();
    const y = run[b].listed.filter((s) => s.d === d).map((s) => s.sym).sort().join();
    return x === y;
  }).length;
  console.log(`${a} vs ${b}: picks ${A.size} / ${B.size}, shared ${both} (Jaccard ${(100 * both / (A.size + B.size - both)).toFixed(1)}%), identical lists on ${same}/${days.size} days (${(100 * same / days.size).toFixed(1)}%)`);
}
