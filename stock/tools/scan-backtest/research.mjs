// Pre-listed structural hypotheses. Selection judged on IS (2023-24); must hold on OOS (2025-26) and per year.
import { SIG, isoos, sim, prodStopSig, IS } from "./lib.mjs";
const cand = SIG.filter((s) => s.score >= 80);
const A = cand.filter((s) => s.pattern === "A");
const AD = cand.filter((s) => s.pattern === "A" || s.pattern === "D");
const LU = SIG.filter((s) => s.dayPct >= 9.5); // every limit-up close, any score
const sec = (t) => console.log(`\n### ${t}`);
const cmp = (label, rows, pred, ret, bench) => {
  console.log(isoos(`${label} YES`, rows.filter(pred), ret, bench));
  console.log(isoos(`${label} NO `, rows.filter((s) => !pred(s)), ret, bench));
};
const q = (arr, p) => { const b = arr.filter((x) => x != null).sort((x, y) => x - y); return b[Math.floor(p * (b.length - 1))]; };

sec("H0 universe: how much of pattern A edge is the score>=80 gate? (limit-up & off60<-15 & supply<=.3, by score)");
const aLike = LU.filter((s) => s.offHi60 < -15 && s.supply <= 0.3);
for (const [lo, hi] of [[0, 70], [70, 80], [80, 90], [90, 101]]) console.log(isoos(`A-like score ${lo}-${hi}`, aLike.filter((s) => s.score >= lo && s.score < hi)));
console.log("(note: score<70 limit-ups are only kept if dayPct>=9.5, so aLike covers all scores)");

sec("H1 market regime at signal date (TAIEX TR index vs MA60 / MA20)");
cmp("A mkt>MA60", A, (s) => s.mkt_ma60 > 0);
cmp("A mkt>MA20", A, (s) => s.mkt_ma20 > 0);
cmp("ALLcand mkt>MA60", cand, (s) => s.mkt_ma60 > 0);

sec("H2 entry timing: T+1 open vs T+1 close (A, T+10)");
console.log(isoos("A enter T+1 close", A, (s) => s.r10));
console.log(isoos("A enter T+1 open ", A, (s) => s.o10));

sec("H3 holding period (A, T+1 close entry)");
for (const h of [3, 5, 10, 20]) console.log(isoos(`A hold ${h}`, A, (s) => s[`r${h}`], (s) => s[`b${h}`]));

sec("H4 exits (A): production stop / no stop / ATR x3 / trailing");
console.log(isoos("A no stop H10", A, (s) => sim(s, { H: 10 })));
console.log(isoos("A prod stop H10", A, (s) => sim(s, { H: 10, stop: prodStopSig(s) })));
console.log(isoos("A 3xATR stop H10", A, (s) => sim(s, { H: 10, stop: 1 - 3 * s.atrPct / 100 })));
console.log(isoos("A trail 10% H10", A, (s) => sim(s, { H: 10, trail: 10 })));

sec("H5 supply share (limit-up & off60<-15, score>=80) — monotonic?");
for (const [lo, hi] of [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.45], [0.45, 1.01]]) console.log(isoos(`supply ${lo}-${hi}`, AD.filter((s) => s.supply >= lo && s.supply < hi)));

sec("H6 depth off 60d high (limit-up, supply<=.3, score>=80)");
const LUs = cand.filter((s) => s.dayPct >= 9.5 && s.supply <= 0.3);
for (const [lo, hi] of [[-100, -35], [-35, -25], [-25, -15], [-15, -5], [-5, 0.01]]) console.log(isoos(`off60 ${lo}..${hi}`, LUs.filter((s) => s.offHi60 >= lo && s.offHi60 < hi)));

sec("H7 limit-up quality (A)");
cmp("A sealed(close=high)", A, (s) => s.sealed);
cmp("A volRatio>=3", A, (s) => s.volRatio >= 3);

sec("H8 first limit-up vs repeated (A)");
cmp("A first LU in 5d", A, (s) => s.prevLU === 0);

sec("H9 liquidity / size (A)");
cmp("A vol>=2000 lots", A, (s) => s.vol >= 2e6);
cmp("A price>=50", A, (s) => s.c >= 50);
cmp("A twse", A, (s) => s.mkt === "twse");

sec("H10 volatility (A) — ATR% tercile split on IS");
const t1 = q(A.filter(IS).map((s) => s.atrPct), 1 / 3), t2 = q(A.filter(IS).map((s) => s.atrPct), 2 / 3);
console.log({ t1, t2 });
for (const [lo, hi] of [[0, t1], [t1, t2], [t2, 99]]) console.log(isoos(`ATR% ${lo}-${hi}`, A.filter((s) => s.atrPct >= lo && s.atrPct < hi)));

sec("H11 next-day behavior (known only at T+1 close — usable because entry is T+1 close)");
cmp("A T+1 close > signal close", A, (s) => s.day1 > 0);
cmp("A T+1 gap-up open", A, (s) => s.gap_next > 0);
