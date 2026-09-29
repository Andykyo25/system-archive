// Production spec of 今日看多 R2p (2026-09-29): exactly what v_scan_verdict + plan levels do.
//   candidates: v_breakout_scan score >= 80
//   filter:     close within 5% of 60-day closing high, overhead supply (<=90 bars) <= 10%, 0050 adj close above its MA60
//   list:       top 3 by score_total desc, day_pct desc
//   trade:      enter T+1 close (skip if T+1 low <= stop), stop = signal close - 3 x ATR14,
//               take profit +10% vs entry, max hold 20 trading days
import { SIG, stats, IS, OOS, sim } from "./lib.mjs";
const f = (x) => (x == null ? "  - " : x.toFixed(1).padStart(5));
const ys = ["2023", "2024", "2025", "2026"];
const stopOf = (s) => 1 - (3 * s.atrPct) / 100;
const pass = (s) => s.score >= 80 && s.offHi60 > -5 && s.supply90 <= 0.1 && s.e50_ma60 > 0;
const byD = new Map();
for (const s of SIG.filter(pass)) { if (!byD.has(s.d)) byD.set(s.d, []); byD.get(s.d).push(s); }
const listed = [...byD.values()].flatMap((a) => a.sort((x, y) => y.score - x.score || y.dayPct - x.dayPct).slice(0, 3));
const traded = listed.filter((s) => s.path?.length >= 20 && s.l1 != null && 1 + s.l1 / 100 > stopOf(s));
const ret = (s) => sim(s, { H: 20, tp: 10, stop: stopOf(s) });
const r = traded.map(ret);
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
const st = stats(traded, ret);
console.log(`listed ${listed.length} on ${byD.size} days; traded ${traded.length} (entry-day stop block ${listed.filter((s) => s.path?.length >= 20).length - traded.length})`);
console.log(`R2p prod spec: win ${f(st.win)} netWin ${f(st.netWin)} meanNet ${f(st.mean)} med ${f(st.med)} pf ${st.pf.toFixed(2)} | IS ${f(stats(traded.filter(IS), ret).win)} OOS ${f(stats(traded.filter(OOS), ret).win)}`);
console.log(`  per-year win    ${ys.map((y) => f(stats(traded.filter((s) => s.d.startsWith(y)), ret).win)).join("")}`);
console.log(`  per-year meanNet${ys.map((y) => f(stats(traded.filter((s) => s.d.startsWith(y)), ret).mean)).join("")}`);
console.log(`  tail: P5 ${f(pct(r, 0.05))} min ${f(Math.min(...r))} share<=-15% ${f((100 * r.filter((x) => x <= -15).length) / r.length)}%`);
const A = SIG.filter((s) => s.score >= 80 && s.pattern === "A" && s.path?.length >= 20);
console.log(`old A (H10, no stop) win ${f(stats(A, (s) => s.r10).win)} per-year ${ys.map((y) => f(stats(A.filter((s) => s.d.startsWith(y)), (s) => s.r10).win)).join("")}`);
