import { SIG, stats, dstats, IS, OOS, sim, prodStopSig } from "./lib.mjs";
const cand = SIG.filter((s) => s.score >= 80);
const f = (x) => (x == null ? "  - " : x.toFixed(1).padStart(5));
console.log("threshold grid (day-weighted T+10 win IS/OOS, pooled meanNet) — base all cand: IS", f(dstats(cand.filter(IS)).dwin), "OOS", f(dstats(cand.filter(OOS)).dwin));
for (const h of [-3, -5, -10]) for (const sp of [0.05, 0.1, 0.2]) {
  const row = [-1, 0, 1].map((m) => { const r = cand.filter((s) => s.offHi250 > h && s.supply <= sp && s.mkt_ma60 > m); return `${f(dstats(r.filter(IS)).dwin)}/${f(dstats(r.filter(OOS)).dwin)} m${f(stats(r).mean)}`; });
  console.log(`hi250>${String(h).padStart(3)} sup<=${sp.toFixed(2)} | mkt>-1: ${row[0]} | mkt>0: ${row[1]} | mkt>1: ${row[2]}`);
}
const R2 = cand.filter((s) => s.offHi250 > -5 && s.supply <= 0.1 && s.mkt_ma60 > 0 && s.path?.length >= 20);
const pct = (a, p) => { const b = a.filter((x) => x != null).sort((x, y) => x - y); return b[Math.floor(p * (b.length - 1))]; };
console.log("\ntail risk on R2 (per-trade % vs entry): P1 / P5 / min / share<=-15%");
for (const [k, v] of Object.entries({ "H10 no stop": { H: 10 }, "H10 prod stop": { H: 10, stop: "prod" }, "H20 tp10 + 3ATR": { H: 20, tp: 10, stop: "atr3" }, "H20 tp10 no stop": { H: 20, tp: 10 } })) {
  const r = R2.map((s) => sim(s, { ...v, stop: v.stop === "prod" ? prodStopSig(s) : v.stop === "atr3" ? 1 - 3 * s.atrPct / 100 : null })).filter((x) => x != null);
  console.log(`${k.padEnd(18)} ${f(pct(r, 0.01))} ${f(pct(r, 0.05))} ${f(Math.min(...r))} ${f(100 * r.filter((x) => x <= -15).length / r.length)}%  win ${f(100 * r.filter((x) => x > 0).length / r.length)} meanNet ${f(r.reduce((a, b) => a + b, 0) / r.length - 0.585)}`);
}
// realistic portfolio: top-3/day by score, R2 + H20 tp10 3ATR vs current A H10
const top = (rows, K) => { const m = new Map(); for (const s of rows) { if (!m.has(s.d)) m.set(s.d, []); m.get(s.d).push(s); } return [...m.values()].flatMap((a) => a.sort((x, y) => y.score - x.score || (y.ret60 ?? 0) - (x.ret60 ?? 0)).slice(0, K)); };
const ys = ["2023", "2024", "2025", "2026"];
const show = (k, rows, ret) => { const st = stats(rows, ret); console.log(`${k.padEnd(34)} n=${String(st.n).padStart(5)} win=${f(st.win)} meanNet=${f(st.mean)} pf=${st.pf?.toFixed(2)} | ${ys.map((y) => f(stats(rows.filter((s) => s.d.startsWith(y)), ret).win)).join("")}`); };
console.log("\nfinal comparison (≤3 picks/day, by score):");
const Acur = cand.filter((s) => s.pattern === "A" && s.path?.length >= 20);
show("現行: A + H10 + 現行停損", top(Acur, 3), (s) => sim(s, { H: 10, stop: prodStopSig(s) }));
show("現行: A + H10 無停損(成績單口徑)", top(Acur, 3), (s) => sim(s, { H: 10 }));
show("改1: R2 + H10 無停損", top(R2, 3), (s) => sim(s, { H: 10 }));
show("改2: R2 + 停利10%/20日/3ATR", top(R2, 3), (s) => sim(s, { H: 20, tp: 10, stop: 1 - 3 * s.atrPct / 100 }));
show("改2': A + 停利10%/20日/3ATR", top(Acur, 3), (s) => sim(s, { H: 20, tp: 10, stop: 1 - 3 * s.atrPct / 100 }));
