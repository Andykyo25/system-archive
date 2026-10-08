import test from "node:test";
import assert from "node:assert/strict";
import { bootDiff, netShare, quantile } from "./inst-pit-lib.mjs";

const dates = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
const index = new Map(dates.map((d, i) => [d, i]));
const day = (rows) => new Map(Object.entries(rows));
// per-day [foreign, trust, dealer, total] for symbol 1111
const instByDate = new Map([
  ["2026-01-05", day({ 1111: [100, 10, 1, 111] })],
  ["2026-01-06", day({ 1111: [200, 20, 2, 222] })],
  ["2026-01-07", day({ 2222: [5, 5, 5, 15] })], // 1111 absent: no institutional trading that day
  ["2026-01-08", day({ 1111: [-400, 40, 4, -356] })],
]);
const ctx = { instByDate, dates, index };
const sig = (d, extra = {}) => ({ d, sym: "1111", vol: 2000, volRatio: 2, ...extra }); // avg20 = 1000

test("netShare sums the last k days (including T) and divides by k times the 20-day average volume", () => {
  assert.equal(netShare(sig("2026-01-06"), "foreign", 2, ctx), (100 + 200) / (2 * 1000));
  assert.equal(netShare(sig("2026-01-08"), "total", 1, ctx), -356 / 1000);
});

test("netShare: a stock missing from a day that has data counts as zero; a day with no data at all gives null", () => {
  // trust over 01-06..01-08 = 20 (01-06) + 0 (absent 01-07) + 40 (01-08)
  assert.equal(netShare(sig("2026-01-08"), "trust", 3, ctx), 60 / 3000);
  const gap = new Map(instByDate); gap.delete("2026-01-06");
  assert.equal(netShare(sig("2026-01-06"), "foreign", 1, { ...ctx, instByDate: gap }), null);
});

test("netShare returns null without a usable volume base or enough history", () => {
  assert.equal(netShare(sig("2026-01-08", { volRatio: null }), "foreign", 1, ctx), null);
  assert.equal(netShare(sig("2026-01-05"), "foreign", 3, ctx), null, "needs 3 days of history");
  assert.equal(netShare(sig("2099-01-01"), "foreign", 1, ctx), null);
});

test("quantile interpolates and ignores nulls", () => {
  assert.equal(quantile([1, 2, 3, 4, null], 0.5), 2.5);
  assert.equal(quantile([10], 0.9), 10);
  assert.equal(quantile([null, NaN], 0.5), null);
  assert.equal(quantile([0, 10], 0.25), 2.5);
});

test("bootDiff resamples whole signal days and returns the point estimate with a 95% interval", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const hi = Array.from({ length: 40 }, (_, i) => ({ d: `d${i % 20}`, r: 5 + (i % 3) }));
  const lo = Array.from({ length: 40 }, (_, i) => ({ d: `d${i % 20}`, r: 1 + (i % 3) }));
  const out = bootDiff(hi, lo, 400, rand);
  assert.ok(Math.abs(out.diff - 4) < 1e-9);
  assert.ok(out.lo95 <= out.diff && out.diff <= out.hi95);
  assert.ok(out.lo95 > 3 && out.hi95 < 5, `interval should be tight around 4, got ${out.lo95}..${out.hi95}`);
  assert.equal(bootDiff([], lo), null);
});
