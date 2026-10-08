// Small, deterministic, regularized models. Training-only transforms.
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
export function transformFit(rows) {
  const p = rows[0].x.length;
  const means = [], scales = [];
  for (let j = 0; j < p; j++) {
    const v = rows.map((r) => r.x[j]).filter(Number.isFinite);
    const mu = v.length ? avg(v) : 0;
    means.push(mu); scales.push(v.length ? Math.sqrt(avg(v.map((x) => (x - mu) ** 2))) || 1 : 1);
  }
  const encode = (x) => [1, ...x.map((v, j) => Number.isFinite(v) ? Math.max(-5, Math.min(5, (v - means[j]) / scales[j])) : 0), ...x.map((v) => Number.isFinite(v) ? 0 : 1)];
  return { means, scales, encode };
}
export function fitLogistic(rows, { ridge = .05, epochs = 600 } = {}) {
  const tr = transformFit(rows), encoded = rows.map((r) => ({ ...r, z: tr.encode(r.x) }));
  const beta = Array(encoded[0].z.length).fill(0), totalW = rows.reduce((s, r) => s + r.w, 0);
  for (let k = 0; k < epochs; k++) {
    const g = Array(beta.length).fill(0);
    for (const r of encoded) { const error = (sigmoid(r.z.reduce((s, x, j) => s + x * beta[j], 0)) - r.y) * r.w / totalW; for (let j = 0; j < beta.length; j++) g[j] += error * r.z[j]; }
    for (let j = 0; j < beta.length; j++) beta[j] -= .2 * (g[j] + (j ? ridge * beta[j] : 0));
  }
  return { means: tr.means, scales: tr.scales, beta, predict: (x) => sigmoid(tr.encode(x).reduce((s, v, j) => s + v * beta[j], 0)) };
}
export function fitTree(rows, { minLeaf = 60, depth = 2 } = {}) {
  const p = rows[0].x.length;
  const cuts = Array.from({ length: p }, (_, j) => {
    const v = rows.map((r) => r.x[j]).filter(Number.isFinite).sort((a, b) => a - b);
    return [.25, .5, .75].map((q) => v.length ? v[Math.floor((v.length - 1) * q)] : 0);
  });
  const impute = cuts.map((a) => a[1]);
  const value = (r, j) => Number.isFinite(r.x[j]) ? r.x[j] : impute[j];
  const count = (a) => { const w = a.reduce((s, r) => s + r.w, 0), yes = a.reduce((s, r) => s + r.w * r.y, 0); return { w, yes, prob: (yes + 1) / (w + 2), impurity: w ? 2 * yes * (w - yes) / w : 0 }; };
  function build(a, left) {
    const c = count(a), node = { n: a.length, probability: c.prob };
    if (left === 0 || a.length < 2 * minLeaf) return node;
    let best = null;
    for (let j = 0; j < p; j++) for (const cut of cuts[j]) {
      const lo = a.filter((r) => value(r, j) <= cut), hi = a.filter((r) => value(r, j) > cut);
      if (lo.length < minLeaf || hi.length < minLeaf) continue;
      const gain = c.impurity - count(lo).impurity - count(hi).impurity;
      if (gain > 1e-12 && (!best || gain > best.gain)) best = { j, cut, lo, hi, gain };
    }
    return best ? { ...node, feature: best.j, cut: best.cut, gain: best.gain, low: build(best.lo, left - 1), high: build(best.hi, left - 1) } : node;
  }
  const tree = build(rows, depth);
  const predict = (x) => { let n = tree; while (n.feature != null) n = (Number.isFinite(x[n.feature]) ? x[n.feature] : impute[n.feature]) <= n.cut ? n.low : n.high; return n.probability; };
  return { tree, impute, predict };
}
