import { SIG, dstats, IS, OOS } from "./lib.mjs";
const cand = SIG.filter((s) => s.score >= 80 && s.r10 != null);
const feats = ["score", "dayPct", "gap", "slope", "rsi", "ret5", "ret20", "ret60", "offHi60", "offHi250", "supply", "atrPct", "volRatio", "vol", "c", "upperShadow", "mkt_ma20", "mkt_ma60", "mkt_ret20", "gap_next", "day1"];
const f = (x) => (x == null ? "  - " : x.toFixed(0).padStart(4));
const g = (x) => (x == null ? "   - " : x.toFixed(1).padStart(5));
console.log("feature: quintile(IS breakpoints) -> dayWin% IS | OOS | 2023 2024 2025 2026 ; dayMeanNet IS|OOS");
for (const k of feats) {
  const v = cand.filter(IS).map((s) => s[k]).filter((x) => x != null).sort((a, b) => a - b);
  const bp = [0.2, 0.4, 0.6, 0.8].map((p) => v[Math.floor(p * (v.length - 1))]);
  const qi = (x) => (x == null ? -1 : bp.filter((b) => x > b).length);
  const parts = [];
  for (let qq = 0; qq < 5; qq++) {
    const r = cand.filter((s) => qi(s[k]) === qq);
    const a = dstats(r.filter(IS)), b = dstats(r.filter(OOS));
    const ys = ["2023", "2024", "2025", "2026"].map((y) => f(dstats(r.filter((s) => s.d.startsWith(y))).dwin)).join("");
    parts.push(`Q${qq + 1}[${qq ? bp[qq - 1].toFixed(1) : "min"}..] ${f(a.dwin)}|${f(b.dwin)} (${ys}) ${g(a.dmean)}|${g(b.dmean)}`);
  }
  console.log(`\n${k}\n  ` + parts.join("\n  "));
}
const all = dstats(cand); console.log("\nALL dayWin", all.dwin.toFixed(1), "IS", dstats(cand.filter(IS)).dwin.toFixed(1), "OOS", dstats(cand.filter(OOS)).dwin.toFixed(1));
