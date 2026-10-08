import test from 'node:test';
import assert from 'node:assert/strict';
import { transformFit, fitLogistic, fitTree } from './short-term-models.mjs';
test('fit scaling never observes future input; missing gets explicit indicator', () => {
  const fit = transformFit([{ x: [1, null] }, { x: [3, 4] }]);
  assert.deepEqual(fit.means, [2, 4]);
  assert.deepEqual(fit.encode([1000, null]), [1, 5, 0, 0, 1]);
  assert.deepEqual(fit.means, [2, 4]);
});
test('regularized logistic learns a known relation with finite missing predictions', () => {
  const a = Array.from({ length: 200 }, (_, i) => ({ x: [i / 100 - 1], y: i >= 100 ? 1 : 0, w: 1 }));
  const model = fitLogistic(a);
  assert.ok(model.predict([.8]) > .7); assert.ok(model.predict([-.8]) < .3);
  assert.ok(Number.isFinite(model.predict([null])));
  assert.deepEqual(fitLogistic(a).beta, model.beta);
});
test('tree respects support and fixed depth, stores only training cuts', () => {
  const a = Array.from({ length: 200 }, (_, i) => ({ x: [i], y: i >= 100 ? 1 : 0, w: 1 }));
  const model = fitTree(a);
  assert.equal(model.tree.cut, 99); assert.equal(model.tree.low.n, 100);
  assert.ok(model.predict([190]) > .9); assert.ok(model.predict([1]) < .1);
  assert.equal(fitTree(a, { minLeaf: 101 }).tree.feature, undefined);
});
