// Run from this directory: node short-term.mjs [--audit-only]
// Protocol: ../../tasks/short-term-protocol-20261008.md. Read-only to source data.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { netShare } from './inst-pit-lib.mjs';
import { COST, referenceReset, simulate, summarize, quantile, trainingRows, dailyValues, blockCI } from './short-term-lib.mjs';
import { fitLogistic, fitTree } from './short-term-models.mjs';
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const SIG = JSON.parse(fs.readFileSync('signals.json'));
const MKT = JSON.parse(fs.readFileSync('market.json'));
const dates = MKT.map((m) => m.d), index = new Map(dates.map((d, i) => [d, i]));
const files = fs.readdirSync('data').filter((f) => /^(twse|tpex|inst_twse|inst_tpex)_\d{8}\.json$/.test(f)).sort();
const digest = crypto.createHash('sha256'), rawByDate = new Map(), instLoad = new Map();
for (const f of files) {
  const b = fs.readFileSync(`data/${f}`); digest.update(f).update(b);
  const m = /^(inst_)?(twse|tpex)_(\d{8})\.json$/.exec(f);
  const d = `${m[3].slice(0, 4)}-${m[3].slice(4, 6)}-${m[3].slice(6)}`;
  const map = m[1] ? instLoad : rawByDate;
  if (!map.has(d)) map.set(d, {});
  map.get(d)[m[2]] = JSON.parse(b).rows ?? {};
}
const instByDate = new Map();
for (const [d, markets] of instLoad) if (Object.keys(markets.twse ?? {}).length && Object.keys(markets.tpex ?? {}).length) instByDate.set(d, new Map([...Object.entries(markets.twse), ...Object.entries(markets.tpex)]));
const previous = new Map(), events = [], coverage = [];
for (let i = 0; i < dates.length; i++) {
  const d = dates[i], markets = rawByDate.get(d) ?? {};
  coverage.push({ d, twse: Object.keys(markets.twse ?? {}).length, tpex: Object.keys(markets.tpex ?? {}).length, inst: instByDate.has(d) });
  for (const [sym, bar] of [...Object.entries(markets.twse ?? {}), ...Object.entries(markets.tpex ?? {})]) {
    const prev = previous.get(sym), close = bar[3], change = bar[5];
    if (!(close > 0)) continue;
    if (prev) {
      const type = referenceReset(prev.close, bar);
      if (type) events.push({ d, i, sym, previous: prev.close, close, change, type });
    }
    previous.set(sym, { close });
  }
}
const bySym = new Map();
for (const e of events) { if (!bySym.has(e.sym)) bySym.set(e.sym, []); bySym.get(e.sym).push(e); }
const affected = (sym, i) => (bySym.get(sym) ?? []).some((e) => e.i >= i - 120 && e.i <= i + 11);
const marketAffected = (i) => (bySym.get('0050') ?? []).some((e) => e.type === 'unknown-reference-reset' && e.i >= i - 120 && e.i <= i);
const pass = (s) => s.score >= 80 && s.offHi60 > -5 && s.supply90 <= .1 && s.e50_ma60 > 0;
const byD = new Map();
for (const s of SIG.filter(pass)) { if (!byD.has(s.d)) byD.set(s.d, []); byD.get(s.d).push(s); }
const listed = [...byD.values()].flatMap((a) => a.sort((x, y) => y.score - x.score || y.dayPct - x.dayPct).slice(0, 3));
const excluded = { immature: [], interrupted: [], corporateAction: [], marketReset: [], incompleteMarket: [] }, usable = [];
for (const s of listed) {
  const i = index.get(s.d);
  let reason = null;
  if (i + 11 >= dates.length) reason = 'immature';
  else if (s.path?.length < 10 || !Number.isFinite(s.day1)) reason = 'interrupted';
  else if (affected(s.sym, i)) reason = 'corporateAction';
  else if (marketAffected(i)) reason = 'marketReset';
  else if (coverage.slice(Math.max(0, i - 120), i + 12).some((x) => x.twse < 500 || x.tpex < 300)) reason = 'incompleteMarket';
  if (reason) excluded[reason].push({ d: s.d, sym: s.sym }); else usable.push(s);
}
const audit = { hashes: { signals: hash('signals.json'), market: hash('market.json'), industry: hash('incl.txt'), rawArchive: digest.digest('hex'), protocol: hash('../../tasks/short-term-protocol-20261008.md') },
  first: dates[0], last: dates.at(-1), calendarDays: dates.length, signalCount: SIG.length, listed: listed.length, usable: usable.length,
  excluded: Object.fromEntries(Object.entries(excluded).map(([k, a]) => [k, a.length])), exclusionDetails: excluded, events, coverage,
  caveats: ['Current industry list is not PIT; historical 2025-26 validation has already been inspected in earlier studies.', 'Corporate-action exclusions do not repair production prices or reconstruct missing signal membership.', 'T+1 reference-close fills, fixed costs, unconstrained overlapping positions; these are trade opportunities, not account returns.', 'Exchange reference changes neutralize distributions; adjusted-index paths are not exact cash dividend/split entitlements or broker fills.'] };
fs.mkdirSync('short-term-output', { recursive: true });
fs.writeFileSync('short-term-output/audit.json', JSON.stringify(audit, null, 2));
console.log(JSON.stringify({ ...audit, exclusionDetails: undefined, events: events.filter((e) => e.sym === '0050' || e.sym === '6949'), coverage: undefined }, null, 2));
if (process.argv.includes('--audit-only')) process.exit(0);

const ctx = { instByDate, dates, index };
const priceFeatures = ['score', 'gap', 'rsi', 'ret5', 'ret20', 'slope', 'atrPct', 'volRatio', 'upperShadow', 'e50_ma60', 'mkt_ma20'];
const features = [...priceFeatures, ...['foreign', 'trust', 'total'].flatMap((k) => [1, 3, 5].map((n) => `${k}${n}`))];
const values = new Map();
for (const s of usable) values.set(s, Object.fromEntries(features.map((f) => { const m = /^(foreign|trust|total)([135])$/.exec(f); return [f, m ? netShare(s, m[1], +m[2], ctx) : s[f]]; })));
const variants = [5, 7, 10].flatMap((H) => [{ id: `H${H}-fixed`, H }, ...[2, 3].flatMap((atr) => [null, 5, 8, 10].map((tp) => ({ id: `H${H}-ATR${atr}-TP${tp ?? 'none'}`, H, atr, tp })))]);
const outcome = new Map(variants.map((v) => [v.id, new Map(usable.map((s) => [s, simulate(s, v)]))]));
const trades = (rows, v, gate = () => true) => rows.filter(gate).flatMap((s) => { const r = outcome.get(v.id).get(s); return r ? [{ ...r, d: s.d, sym: s.sym }] : []; });
const evaluation = (rows, v, gate) => { const t = trades(rows, v, gate); return { ...summarize(t), stress: summarize(t, .985), coverage: t.length / rows.length, optimisticDelta: t.length ? rows.filter(gate ?? (() => true)).map((s) => { const low = outcome.get(v.id).get(s), high = simulate(s, { ...v, optimistic: true }); return low && high ? high.gross - low.gross : null; }).filter(Number.isFinite).reduce((a, b) => a + b, 0) / t.length : null }; };
const rounds = [], selectedDifferences = [], modelDifferences = { logistic: [], tree: [] };
for (const y of [2024, 2025, 2026]) {
  const train = trainingRows(usable, dates, `${y}-01-01`), test = usable.filter((s) => s.d.startsWith(String(y)));
  const grid = variants.map((v) => ({ v, stat: evaluation(train, v) }));
  // Require usable training support and >=80% entry acceptance; expected return first.
  const best = grid.filter((x) => x.stat.n >= 100 && x.stat.days >= 80 && x.stat.coverage >= .8).sort((a, b) => b.stat.dayAvg - a.stat.dayAvg || b.stat.dayWin - a.stat.dayWin)[0];
  if (!best) { rounds.push({ year: y, error: 'insufficient-training-support' }); continue; }
  const v = best.v, baseline = best.stat;
  const rules = features.flatMap((feature) => {
    const cut = quantile(train.map((s) => values.get(s)[feature]), .5);
    return ['high', 'low'].map((direction) => {
      const gate = (s) => cut != null && Number.isFinite(values.get(s)[feature]) && (direction === 'high' ? values.get(s)[feature] > cut : values.get(s)[feature] <= cut);
      const stat = evaluation(train, v, gate);
      return { feature, cut, direction, gate, stat, eligible: stat.n >= 100 && stat.days >= 80 && stat.coverage >= .4 && stat.dayWin >= baseline.dayWin + 3 && stat.dayAvg > baseline.dayAvg && stat.p5 >= baseline.p5 };
    });
  });
  const chosen = rules.filter((r) => r.eligible).sort((a, b) => b.stat.dayAvg - a.stat.dayAvg)[0];
  const gate = chosen?.gate ?? (() => true);
  const testDates = dates.filter((d) => d.startsWith(String(y)) && index.get(d) + 11 < dates.length);
  const baseTrades = trades(test, v), filteredTrades = trades(test, v, gate);
  const baseDaily = dailyValues(baseTrades, testDates, COST, 3), selectedDaily = dailyValues(filteredTrades, testDates, COST, 3);
  const diff = selectedDaily.map((x, i) => x.avg - baseDaily[i].avg);
  selectedDifferences.push(...diff);
  const ci = blockCI(diff);
  // All feature tests disclosed; adjusted CIs use same eligible market date vector.
  const diagnostics = rules.map(({ gate: ruleGate, ...r }) => {
    const rr = trades(test, v, ruleGate), daily = dailyValues(rr, testDates, COST, 3);
    return { ...r, test: evaluation(test, v, ruleGate), ci: blockCI(daily.map((x, i) => x.avg - baseDaily[i].avg), { B: 10000, alpha: .05 / 40 }) };
  });
  rounds.push({ year: y, trainN: train.length, trainLast: train.at(-1)?.d, testN: test.length, variant: v, trainBaseline: baseline,
    chosen: chosen ? { feature: chosen.feature, cut: chosen.cut, direction: chosen.direction, stat: chosen.stat } : null,
    testBaseline: evaluation(test, v), testSelected: evaluation(test, v, gate), cashDateDeltaCI: ci, diagnostics,
    exitGrid: grid.map((x) => ({ variant: x.v, train: x.stat, test: evaluation(test, x.v) })) });
}
// Descriptive full-history comparisons. No new thresholds selected here.
const descriptive = variants.map((v) => ({ variant: v, all: evaluation(usable, v), years: Object.fromEntries([2023, 2024, 2025, 2026].map((y) => [y, evaluation(usable.filter((s) => s.d.startsWith(String(y))), v)])) }));
const fixed = variants.filter((v) => v.atr == null);
const entryComparison = fixed.map((v) => {
  const tt = usable.flatMap((s) => { const r = outcome.get(v.id).get(s); if (!r || !Number.isFinite(s.gap_next)) return []; const ratio = (1 + s.day1 / 100) / (1 + s.gap_next / 100); return [{ d: s.d, gross: ((1 + r.gross / 100) * ratio - 1) * 100, held: v.H }]; });
  return { H: v.H, close: evaluation(usable, v), openReference: summarize(tt), caveat: 'Open entry includes T+1 intraday exposure; no stop model on entry-day path. Ideal auction fills are descriptive only.' };
});
const modelRounds = [];
const modelExit = variants.find((v) => v.id === 'H10-ATR3-TP10');
const modelX = (s) => features.map((f) => values.get(s)[f]);
const selectOne = (rows, predict) => {
  const groups = new Map();
  for (const s of rows) { if (!groups.has(s.d)) groups.set(s.d, []); groups.get(s.d).push(s); }
  return [...groups.values()].map((a) => a.slice().sort((x, y) => predict(y) - predict(x) || y.score - x.score || y.dayPct - x.dayPct)[0]);
};
for (const y of [2024, 2025, 2026]) {
  const train = trainingRows(usable, dates, `${y}-01-01`), test = usable.filter((s) => s.d.startsWith(String(y)));
  const trainLabelled = train.filter((s) => outcome.get(modelExit.id).get(s));
  const dayN = new Map(); for (const s of trainLabelled) dayN.set(s.d, (dayN.get(s.d) ?? 0) + 1);
  const data = trainLabelled.map((s) => ({ x: modelX(s), y: +(outcome.get(modelExit.id).get(s).gross > COST), w: 1 / dayN.get(s.d) }));
  const constant = data.reduce((sum, r) => sum + r.y * r.w, 0) / data.reduce((sum, r) => sum + r.w, 0);
  const models = { logistic: fitLogistic(data), tree: fitTree(data) };
  const testDates = dates.filter((d) => d.startsWith(String(y)) && index.get(d) + 11 < dates.length);
  const original = selectOne(test, (s) => s.score * 100 + s.dayPct);
  const originalTrades = trades(original, modelExit), originalDaily = dailyValues(originalTrades, testDates, COST, 1);
  const each = Object.entries(models).map(([name, model]) => {
    const predict = (s) => model.predict(modelX(s)), picked = selectOne(test, predict);
    const rows = trades(picked, modelExit), daily = dailyValues(rows, testDates, COST, 1);
    const diff = daily.map((x, i) => x.avg - originalDaily[i].avg);
    modelDifferences[name].push(...diff);
    const observed = test.filter((s) => outcome.get(modelExit.id).get(s));
    const brier = observed.reduce((sum, s) => sum + (predict(s) - +(outcome.get(modelExit.id).get(s).gross > COST)) ** 2, 0) / observed.length;
    const constantBrier = observed.reduce((sum, s) => sum + (constant - +(outcome.get(modelExit.id).get(s).gross > COST)) ** 2, 0) / observed.length;
    return { name, stat: evaluation(picked, modelExit), retainedOfAll: rows.length / test.length, brier, constantBrier,
      deltaCI: blockCI(diff, { alpha: .025, B: 10000 }),
      model: name === 'tree' ? { tree: model.tree, impute: model.impute, features } : { beta: model.beta, means: model.means, scales: model.scales, features } };
  });
  modelRounds.push({ year: y, trainN: data.length, trainLast: train.at(-1)?.d, testN: test.length, originalTop1: evaluation(original, modelExit), originalTop3: evaluation(test, modelExit), models: each });
}
const aggregateCI = { selectedGates: blockCI(selectedDifferences), models: Object.fromEntries(Object.entries(modelDifferences).map(([k, a]) => [k, blockCI(a, { alpha: .025, B: 10000 })])) };
const missingStress = fixed.map((v) => ({ H: v.H, description: 'Hypothetical gross -100% for all 7 interrupted mature labels, NOT observed losses or imputation.', stat: summarize([...trades(usable, v), ...excluded.interrupted.map((s) => ({ ...s, gross: -100, held: v.H }))]) }));
const codeHashes = Object.fromEntries(['short-term.mjs', 'short-term-lib.mjs', 'short-term-models.mjs', 'inst-pit-lib.mjs'].map((f) => [f, hash(f)]));
const result = { audit: { ...audit, exclusionDetails: undefined, events: undefined, coverage: undefined }, codeHashes, cost: COST, variants: variants.length, rulesPerRound: features.length * 2, rounds, descriptive, entryComparison, modelRounds, aggregateCI, missingStress };
fs.writeFileSync('short-term-output/results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ output: 'short-term-output/results.json', cost: COST, variants: variants.length, rulesPerRound: features.length * 2,
  rounds: rounds.map((r) => ({ year: r.year, variant: r.variant, chosen: r.chosen, testBaseline: r.testBaseline, testSelected: r.testSelected, cashDateDeltaCI: r.cashDateDeltaCI })), aggregateCI }, null, 2));
