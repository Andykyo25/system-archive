import { SIG, stats, dstats, IS, OOS } from "./lib.mjs";
const cand = SIG.filter((s) => s.score >= 80);
const nearHi = (s) => s.offHi250 > -5;           // IS Q3+ breakpoint -4.8
const lowSup = (s) => s.supply <= 0.1;           // IS Q1-Q3
const mkUp = (s) => s.mkt_ma60 > 0;              // market above quarterly line
const strong = (s) => s.ret60 > 25;              // IS Q4+
const rules = {
  "現行 A": (s) => s.pattern === "A",
  "全部候選(≥80)": () => true,
  "R1 近一年高+低套牢": (s) => nearHi(s) && lowSup(s),
  "R2 R1+大盤季線上": (s) => nearHi(s) && lowSup(s) && mkUp(s),
  "R3 R2+60日漲>25%": (s) => nearHi(s) && lowSup(s) && mkUp(s) && strong(s),
};
const ys = ["2023", "2024", "2025", "2026"];
const f = (x) => (x == null ? "  - " : x.toFixed(1).padStart(5));
console.log("rule | pooled: n win meanNet | day-weighted win: IS OOS | per-year dayWin 23 24 25 26 | per-year meanNet");
for (const [k, p] of Object.entries(rules)) {
  const r = cand.filter(p), st = stats(r);
  const yw = ys.map((y) => f(dstats(r.filter((s) => s.d.startsWith(y))).dwin)).join(" ");
  const ym = ys.map((y) => f(stats(r.filter((s) => s.d.startsWith(y))).mean)).join(" ");
  console.log(`${k.padEnd(16)} n=${String(st.n).padStart(5)} win=${f(st.win)} mNet=${f(st.mean)} | dIS=${f(dstats(r.filter(IS)).dwin)} dOOS=${f(dstats(r.filter(OOS)).dwin)} | ${yw} | ${ym}`);
}
// realistic: per day take top-K by score (ties: ret60) among rule matches
console.log("\n--- realistic: at most K picks/day (rank by score, then ret60) ---");
for (const K of [1, 3]) for (const [k, p] of Object.entries(rules)) {
  const byD = new Map(); for (const s of cand.filter(p)) { if (!byD.has(s.d)) byD.set(s.d, []); byD.get(s.d).push(s); }
  const picks = [...byD.values()].flatMap((a) => a.sort((x, y) => y.score - x.score || (y.ret60 ?? 0) - (x.ret60 ?? 0)).slice(0, K));
  const yw = ys.map((y) => f(stats(picks.filter((s) => s.d.startsWith(y))).win)).join(" ");
  const st = stats(picks);
  console.log(`K=${K} ${k.padEnd(16)} n=${String(st.n).padStart(5)} win=${f(st.win)} mNet=${f(st.mean)} med=${f(st.med)} pf=${st.pf?.toFixed(2)} | IS ${f(stats(picks.filter(IS)).win)} OOS ${f(stats(picks.filter(OOS)).win)} | ${yw}`);
}
