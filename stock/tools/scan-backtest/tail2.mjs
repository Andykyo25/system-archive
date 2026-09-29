import { SIG, stats, IS, OOS, sim, prodStopSig } from "./lib.mjs";
const R2 = SIG.filter((s) => s.score >= 80 && s.offHi250 > -5 && s.supply <= 0.1 && s.mkt_ma60 > 0 && s.path?.length >= 20);
const f = (x) => x.toFixed(1).padStart(5);
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
const ys = ["2023", "2024", "2025", "2026"];
for (const [k, v] of Object.entries({
  "H20 tp10 + 現行停損": (s) => ({ H: 20, tp: 10, stop: prodStopSig(s) }),
  "H20 tp10 + 2ATR": (s) => ({ H: 20, tp: 10, stop: 1 - 2 * s.atrPct / 100 }),
  "H20 tp10 + 固定-10%": () => ({ H: 20, tp: 10, stop: 0.9 }),
  "H20 tp10 + 3ATR": (s) => ({ H: 20, tp: 10, stop: 1 - 3 * s.atrPct / 100 }),
})) {
  const ret = (s) => sim(s, v(s)); const r = R2.map(ret).filter((x) => x != null);
  const st = stats(R2, ret);
  console.log(`${k.padEnd(20)} win ${f(st.win)} meanNet ${f(st.mean)} P5 ${f(pct(r, 0.05))} <=-15%: ${f(100 * r.filter((x) => x <= -15).length / r.length)}% | IS ${f(stats(R2.filter(IS), ret).win)} OOS ${f(stats(R2.filter(OOS), ret).win)} | ${ys.map((y) => f(stats(R2.filter((s) => s.d.startsWith(y)), ret).win)).join("")} ; mean ${ys.map((y) => f(stats(R2.filter((s) => s.d.startsWith(y)), ret).mean)).join("")}`);
}
