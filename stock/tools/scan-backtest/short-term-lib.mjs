// Independent research helpers. No filesystem, network, or production mutations.
export const COST = 0.785; // 0.1425%x2 + 0.3% tax + 0.1%x2 slippage; approximate pp.
export const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
// Missing exchange reference change across a large raw-price discontinuity is
// not a trading loss. Known large rescaling also invalidates mixed-unit volume.
export function referenceReset(previousClose, bar) {
  const close = bar[3], change = bar[5];
  if (!(previousClose > 0 && close > 0)) return null;
  const ref = Number.isFinite(change) ? close - change : close;
  if (Math.abs(ref / previousClose - 1) <= .2) return null;
  return Number.isFinite(change) ? 'known-reference-rescale' : 'unknown-reference-reset';
}
export function quantile(a, q) {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return null;
  const p = (v.length - 1) * q, i = Math.floor(p);
  return v[i] + (v[Math.ceil(p)] - v[i]) * (p - i);
}
export function simulate(s, { H, atr = null, tp = null, optimistic = false }) {
  if (!Number.isFinite(s.day1) || s.path?.length < H) return null;
  const stop = atr == null ? null : ((1 - atr * s.atrPct / 100) / (1 + s.day1 / 100) - 1) * 100;
  if (atr != null && (!Number.isFinite(s.l1) || !Number.isFinite(stop) || 1 + s.l1 / 100 <= 1 - atr * s.atrPct / 100)) return null;
  for (let j = 0; j < H; j++) {
    const [o, h, l, c] = s.path[j];
    if (![o, h, l, c].every(Number.isFinite)) return null;
    // Opening auction precedes intraday low/high. Same-day double touch is unknown.
    if (stop != null && o <= stop) return { gross: o, held: j + 1, cause: 'gap-stop', ambiguous: false };
    if (tp != null && o >= tp) return { gross: o, held: j + 1, cause: 'gap-tp', ambiguous: false };
    const sl = stop != null && l <= stop, take = tp != null && h >= tp;
    if (sl || take) return { gross: sl && !(take && optimistic) ? stop : tp, held: j + 1, cause: sl && !(take && optimistic) ? 'stop' : 'tp', ambiguous: sl && take };
    if (j === H - 1) return { gross: c, held: H, cause: 'time', ambiguous: false };
  }
  return null;
}
export function summarize(rows, cost = COST) {
  const values = rows.map((x) => x.gross - cost), byD = new Map();
  for (const x of rows) { if (!byD.has(x.d)) byD.set(x.d, []); byD.get(x.d).push(x.gross - cost); }
  const daily = [...byD.values()];
  const gain = values.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const loss = -values.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  return { n: rows.length, days: byD.size, win: mean(values.map((x) => 100 * (x > 0))), avg: mean(values), median: quantile(values, .5), p5: quantile(values, .05), worst: values.length ? Math.min(...values) : null,
    profitFactor: loss ? gain / loss : null, dayWin: mean(daily.map((a) => mean(a.map((x) => 100 * (x > 0))))), dayAvg: mean(daily.map(mean)),
    ambiguous: rows.filter((x) => x.ambiguous).length, avgHeld: mean(rows.map((x) => x.held)) };
}
// Labels used for selection must finish >=11 market dates before test start.
export function trainingRows(rows, dates, testStart, embargo = 11) {
  const start = dates.findIndex((d) => d >= testStart);
  const index = new Map(dates.map((d, i) => [d, i]));
  return rows.filter((s) => s.d >= '2023-01-01' && index.has(s.d) && index.get(s.d) + 1 + 10 < start - embargo);
}
export function dailyValues(rows, dates, cost = COST, slots = null) {
  const grouped = new Map();
  for (const x of rows) { if (!grouped.has(x.d)) grouped.set(x.d, []); grouped.get(x.d).push(x.gross - cost); }
  // All market dates retained. Fixed slots keep rejected allocations in cash;
  // this is an opportunity comparison, not a concurrent-position equity curve.
  return dates.map((d) => { const a = grouped.get(d); return a ? { avg: slots == null ? mean(a) : a.reduce((s, x) => s + x, 0) / slots, win: mean(a.map((x) => 100 * (x > 0))), active: 1 } : { avg: 0, win: null, active: 0 }; });
}
export function blockCI(differences, { B = 5000, block = 20, alpha = .05, seed = 20261008 } = {}) {
  if (!differences.length || !differences.every(Number.isFinite)) return null;
  let state = seed;
  const rand = () => ((state = (state * 16807) % 2147483647) / 2147483647);
  const sampled = [];
  for (let b = 0; b < B; b++) {
    let sum = 0, n = 0;
    while (n < differences.length) {
      const start = Math.floor(rand() * differences.length);
      for (let j = 0; j < block && n < differences.length; j++, n++) sum += differences[(start + j) % differences.length];
    }
    sampled.push(sum / n);
  }
  return { delta: mean(differences), lo: quantile(sampled, alpha / 2), hi: quantile(sampled, 1 - alpha / 2), block, B, alpha };
}
