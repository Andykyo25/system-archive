import test from "node:test";
import assert from "node:assert/strict";
import { ambiguousDay, r2pTraded, stopPct } from "./intraday-lib.mjs";

// day1 = 0 → entry price equals signal close, so stop (relative to signal close) maps 1:1 to % vs entry
const sig = (path, extra = {}) => ({ day1: 0, path, ...extra });
const flat = (n) => Array.from({ length: n }, () => [0, 1, -1, 0]);
const H = 20;
const opts = { H, stop: 0.9, tp: 10 }; // stop = -10% vs entry, take profit = +10%

test("stopPct converts a stop level (relative to signal close) into % vs the entry close", () => {
  assert.ok(Math.abs(stopPct({ day1: 0 }, 0.9) - -10) < 1e-9);
  assert.ok(Math.abs(stopPct({ day1: 5 }, 0.9) - ((0.9 / 1.05 - 1) * 100)) < 1e-9);
});

test("a first-event day touching both stop and take-profit is ambiguous", () => {
  const path = flat(H);
  path[3] = [0, 11, -11, 0];
  const a = ambiguousDay(sig(path), opts);
  assert.equal(a.j, 3);
  assert.ok(a.h >= 10 && a.l <= -10);
});

test("only-stop or only-take-profit days are not ambiguous", () => {
  const stopOnly = flat(H); stopOnly[2] = [0, 3, -11, 0];
  const tpOnly = flat(H); tpOnly[2] = [0, 11, -3, 0];
  assert.equal(ambiguousDay(sig(stopOnly), opts), null);
  assert.equal(ambiguousDay(sig(tpOnly), opts), null);
  assert.equal(ambiguousDay(sig(flat(H)), opts), null);
});

test("gaps through a level at the open settle the trade before any intraday question", () => {
  const gapDown = flat(H); gapDown[1] = [-12, 11, -13, -12]; // opens below the stop
  assert.equal(ambiguousDay(sig(gapDown), opts), null);
});

test("an earlier unambiguous exit ends the question; a gap-up open at the target with a deep low is ambiguous", () => {
  const early = flat(H); early[1] = [0, 11, -3, 0]; early[5] = [0, 11, -11, 0];
  assert.equal(ambiguousDay(sig(early), opts), null);
  const gapUp = flat(H); gapUp[4] = [11, 12, -11, 0]; // sim would call this a stop; the open already hit the target
  assert.equal(ambiguousDay(sig(gapUp), opts).j, 4);
});

test("too-short paths and missing entry data return null", () => {
  assert.equal(ambiguousDay(sig(flat(5)), opts), null);
  assert.equal(ambiguousDay({ day1: null, path: flat(H) }, opts), null);
});

test("r2pTraded applies the production filter: score, 60-day high, supply, 0050 trend, and the entry-day stop block", () => {
  const mk = (extra = {}) => ({ d: "2025-01-02", sym: "1111", score: 90, offHi60: -2, supply90: 0.05, e50_ma60: 1, dayPct: 5, atrPct: 3, day1: 1, l1: 0, path: flat(20), ...extra });
  const { traded } = r2pTraded([mk(), mk({ sym: "2222", score: 70 }), mk({ sym: "3333", offHi60: -8 }), mk({ sym: "4444", l1: -20 })]);
  assert.deepEqual(traded.map((s) => s.sym), ["1111"]);
});
