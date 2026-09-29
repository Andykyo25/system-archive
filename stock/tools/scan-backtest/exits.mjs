import { SIG, stats, IS, OOS, sim, prodStopSig } from "./lib.mjs";
const R2 = SIG.filter((s) => s.score >= 80 && s.offHi250 > -5 && s.supply <= 0.1 && s.mkt_ma60 > 0 && s.path?.length >= 20);
const A = SIG.filter((s) => s.score >= 80 && s.pattern === "A" && s.path?.length >= 20);
const f = (x) => (x == null ? "  - " : x.toFixed(1).padStart(5));
const ys = ["2023", "2024", "2025", "2026"];
const variants = {
  "H10 無停損(現行成績單口徑)": { H: 10 },
  "H10 現行停損(2ATR/月線,≤-4%)": { H: 10, stop: "prod" },
  "H10 3ATR 停損": { H: 10, stop: "atr3" },
  "H5 無停損": { H: 5 }, "H20 無停損": { H: 20 },
  "H10 停利+5%": { H: 10, tp: 5 }, "H10 停利+8%": { H: 10, tp: 8 }, "H10 停利+10%": { H: 10, tp: 10 }, "H10 停利+15%": { H: 10, tp: 15 },
  "H10 停利+8% + 3ATR停損": { H: 10, tp: 8, stop: "atr3" },
  "H20 停利+10% + 3ATR停損": { H: 20, tp: 10, stop: "atr3" },
  "H20 移動停利10%": { H: 20, trail: 10 },
};
for (const [nm, U] of [["R2", R2], ["現行A", A]]) {
  console.log(`\n=== ${nm} (n=${U.length}) : win | meanNet | med | pf | IS win / OOS win | per-year win ; per-year meanNet`);
  for (const [k, v] of Object.entries(variants)) {
    const ret = (s) => sim(s, { ...v, stop: v.stop === "prod" ? prodStopSig(s) : v.stop === "atr3" ? 1 - 3 * s.atrPct / 100 : null });
    const st = stats(U, ret);
    console.log(`${k.padEnd(26)} ${f(st.win)} | ${f(st.mean)} | ${f(st.med)} | ${st.pf?.toFixed(2)} | ${f(stats(U.filter(IS), ret).win)} / ${f(stats(U.filter(OOS), ret).win)} | ${ys.map((y) => f(stats(U.filter((s) => s.d.startsWith(y)), ret).win)).join("")} ; ${ys.map((y) => f(stats(U.filter((s) => s.d.startsWith(y)), ret).mean)).join("")}`);
  }
}
