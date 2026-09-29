import fs from "node:fs";
export const SIG = JSON.parse(fs.readFileSync("signals.json", "utf8"));
export const MKT = JSON.parse(fs.readFileSync("market.json", "utf8"));
export const COST = 0.585; // round-trip % (fees 0.1425%x2 x0.6 discount + 0.3% tax), same as run-backtest
export const year = (s) => s.d.slice(0, 4);
export const IS = (s) => s.d < "2025-01-01";
export const OOS = (s) => s.d >= "2025-01-01";
const med = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const f1 = (x) => (x == null ? "  -  " : x.toFixed(1).padStart(5));
// stats over rows using return getter ret(s) (percent). win = ret>0 (system's 上漲比例); netWin = ret>COST
export function stats(rows, ret = (s) => s.r10, bench = (s) => s.b10) {
  const v = rows.filter((s) => ret(s) != null);
  const r = v.map(ret);
  const ex = v.filter((s) => bench(s) != null).map((s) => ret(s) - bench(s));
  const pos = r.filter((x) => x > 0).reduce((a, b) => a + b, 0), neg = -r.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return {
    n: v.length, days: new Set(v.map((s) => s.d)).size,
    win: v.length ? (100 * r.filter((x) => x > 0).length) / v.length : null,
    netWin: v.length ? (100 * r.filter((x) => x > COST).length) / v.length : null,
    mean: v.length ? r.reduce((a, b) => a + b, 0) / v.length - COST : null, // net of cost
    med: med(r),
    exc: ex.length ? ex.reduce((a, b) => a + b, 0) / ex.length : null,
    pf: neg ? pos / neg : null,
  };
}
export function line(label, st) {
  return `${label.padEnd(34)} n=${String(st.n).padStart(5)} d=${String(st.days).padStart(4)} win=${f1(st.win)} netWin=${f1(st.netWin)} meanNet=${f1(st.mean)} med=${f1(st.med)} exc=${f1(st.exc)} pf=${st.pf == null ? "-" : st.pf.toFixed(2)}`;
}
export function byYear(label, rows, ret, bench) {
  const out = [line(label + " ALL", stats(rows, ret, bench))];
  for (const y of ["2023", "2024", "2025", "2026"]) out.push(line(`  ${y}`, stats(rows.filter((s) => year(s) === y), ret, bench)));
  return out.join("\n");
}
export function isoos(label, rows, ret, bench) {
  return [line(label + " IS 23-24", stats(rows.filter(IS), ret, bench)), line(label + " OOS 25-26", stats(rows.filter(OOS), ret, bench))].join("\n");
}
// production live mechanism: pattern confidence from last 60 scan days with settled T+10 as of signal date
export function liveGate(cands, { minUp = 55, minN = 30, lookback = 60 } = {}) {
  const dates = [...new Set(cands.map((s) => s.d))].sort();
  const allDates = MKT.map((m) => m.d); const di = new Map(allDates.map((d, i) => [d, i]));
  const byD = new Map(); for (const s of cands) { if (!byD.has(s.d)) byD.set(s.d, []); byD.get(s.d).push(s); }
  const taken = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i], t = di.get(d);
    const win = dates.slice(Math.max(0, i - lookback + 1), i + 1); // includes today, like prod (recent 60 pick dates)
    const st = {};
    for (const wd of win) {
      if (di.get(wd) + 11 > t) continue; // T+10 not settled yet (exit = t+1+10 close, known after that close)
      for (const s of byD.get(wd)) { if (s.r10 == null) continue; (st[s.pattern] ??= []).push(s.r10 > 0); }
    }
    for (const s of byD.get(d)) {
      const a = st[s.pattern]; if (!a) continue;
      const up = (100 * a.filter(Boolean).length) / a.length;
      if (a.length >= minN && up >= minUp) taken.push(s);
    }
  }
  return taken;
}
// production stop (verdict_plan_levels, antiChase:false): max(close-2*ATR14, MA20), capped <= close*0.97*0.99; relative to signal close
export function prodStopSig(s, mult = 2) {
  const atrStop = 1 - (mult * s.atrPct) / 100, ma20 = 1 / (1 + s.gap / 100);
  return Math.min(Math.max(atrStop, ma20), 0.97 * 0.99);
}
// simulate hold with optional stop (level relative to signal close), take-profit (% vs entry), max hold H days.
// entry = T+1 close. returns % vs entry, or null if path too short. blockEntry: skip if T+1 low <= stop (live gate).
export function sim(s, { H = 10, stop = null, tp = null, trail = null } = {}) {
  if (s.day1 == null || !s.path || s.path.length < H) return null;
  const e = 1 + s.day1 / 100;
  let stopE = stop == null ? null : (stop / e - 1) * 100;
  let peak = 0;
  for (let j = 0; j < H; j++) {
    const [o, h, l, c] = s.path[j];
    if (stopE != null) { if (o <= stopE) return o; if (l <= stopE) return stopE; }
    if (tp != null) { if (o >= tp) return o; if (h >= tp) return tp; }
    if (trail != null) { peak = Math.max(peak, h); const ts = (1 + peak / 100) * (1 - trail / 100) * 100 - 100; stopE = stopE == null ? ts : Math.max(stopE, ts); }
    if (j === H - 1) return c;
  }
}
// day-clustered stats: each scan day weighs 1 (avg within day first). win = share of picks with ret>0
export function dstats(rows, ret = (s) => s.r10) {
  const byD = new Map();
  for (const s of rows) { const r = ret(s); if (r == null) continue; if (!byD.has(s.d)) byD.set(s.d, []); byD.get(s.d).push(r); }
  const w = [], m = [];
  for (const a of byD.values()) { w.push(a.filter((x) => x > 0).length / a.length); m.push(a.reduce((x, y) => x + y, 0) / a.length); }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return { days: byD.size, n: [...byD.values()].reduce((x, a) => x + a.length, 0), dwin: avg(w) == null ? null : 100 * avg(w), dmean: avg(m) == null ? null : avg(m) - COST };
}
