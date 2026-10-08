import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceReset, simulate, summarize, trainingRows, dailyValues, blockCI, quantile } from './short-term-lib.mjs';
const sample = (path) => ({ day1: 0, l1: 0, atrPct: 2, path });
test('6949 missing split reference isolated; known 0050 rescaling differs from true return', () => {
  assert.equal(referenceReset(1490, [81.9, 81.9, 67.1, 67.1, 24486488, null]), 'unknown-reference-reset');
  assert.equal(referenceReset(188.65, [47, 48, 46, 47.57, 1000000, .41]), 'known-reference-rescale');
  assert.equal(referenceReset(100, [90, 90, 89, 90, 1000000, -10]), null);
  assert.equal(referenceReset(null, [90, 90, 89, 90, 1000000, null]), null);
});
test('opening profit precedes later intraday stop', () => {
  const r = simulate(sample([[6, 7, -8, 0]]), { H: 1, atr: 3, tp: 5 });
  assert.equal(r.gross, 6); assert.equal(r.cause, 'gap-tp'); assert.equal(r.ambiguous, false);
});
test('double touch remains ambiguous with conservative and optimistic bounds', () => {
  const s = sample([[0, 7, -8, 0]]), v = { H: 1, atr: 3, tp: 5 };
  assert.ok(Math.abs(simulate(s, v).gross + 6) < 1e-9);
  assert.equal(simulate(s, v).ambiguous, true); assert.equal(simulate(s, { ...v, optimistic: true }).gross, 5);
});
test('gap stop executes worse than target; entry-day stop blocks and missing values fail', () => {
  assert.equal(simulate(sample([[-12, -9, -15, -13]]), { H: 1, atr: 3 }).gross, -12);
  assert.equal(simulate({ ...sample([[0, 1, -1, 0]]), l1: -7 }, { H: 1, atr: 3 }), null);
  assert.equal(simulate(sample([[null, 1, 0, 0]]), { H: 1 }), null);
  assert.equal(simulate(sample([]), { H: 5 }), null);
});
test('five days starts AFTER entry, costs affect wins, same-day weights separate', () => {
  const s = sample(Array.from({ length: 5 }, (_, j) => [0, j + 2, -1, j + 1]));
  assert.equal(simulate(s, { H: 5 }).gross, 5);
  const a = summarize([{ d: 'a', gross: .6 }, { d: 'a', gross: 1 }, { d: 'b', gross: -1 }]);
  assert.ok(Math.abs(a.win - 100 / 3) < 1e-9); assert.equal(a.dayWin, 25);
});
test('purge and embargo prevent unresolved training outcomes', () => {
  const dates = Array.from({ length: 60 }, (_, i) => `2023-${String(i).padStart(3, '0')}`);
  const rows = dates.map((d) => ({ d }));
  const train = trainingRows(rows, dates, dates[50]);
  assert.equal(train.at(-1).d, dates[27]);
  assert.equal(trainingRows(rows, dates, '2099-01-01').length, 0);
});
test('cash dates preserved and block bootstrap deterministic', () => {
  assert.deepEqual(dailyValues([{ d: 'b', gross: 1 }], ['a', 'b'], 0).map((x) => x.avg), [0, 1]);
  assert.deepEqual(dailyValues([{ d: 'b', gross: 3 }], ['a', 'b'], 0, 3).map((x) => x.avg), [0, 1]);
  assert.equal(quantile([null, 1, 3], .5), 2);
  const ci = blockCI([2, 2, 2], { B: 100 }); assert.equal(ci.lo, 2); assert.equal(ci.hi, 2);
  assert.deepEqual(blockCI([1, 2, -3], { B: 100 }), blockCI([1, 2, -3], { B: 100 }));
});
