import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runDailyLedger,
  maxDrawdown,
  dailySharpe,
} from "../supabase/functions/run-backtest/ledger.ts";

const dates = Array.from({ length: 6 }, (_, i) => `2026-08-0${i + 1}`);
const fill = (day, price = 100, phase = "open") => ({
  date: dates[day],
  price,
  phase,
});
const order = (id, symbol, entry, exit, fees = {}) => ({
  id,
  symbol,
  rank: 1,
  entry,
  exit,
  buyFee: 0,
  sellFee: 0,
  ...fees,
});
const window = (day, end, slots, orders) => ({
  date: dates[day],
  phase: "open",
  expiresOn: dates[end],
  slots,
  orders,
});
const run = (windows, closeAt = () => 100) =>
  runDailyLedger({ dates, windows, closeAt, initialCapital: 1000 });
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("daily equity catches an intra-period drawdown and missing slots stay cash", () => {
  const result = run(
    [window(0, 5, 2, [order("a", "A", fill(0), fill(5))])],
    (_, date) => (date === dates[2] ? 50 : 100),
  );
  assert.equal(result.daily[2].cash, 500);
  assert.equal(result.daily[2].marketValue, 250);
  assert.equal(result.daily[2].equity, 750);
  assert.equal(result.maxDrawdownPct, 25);
  assert.equal(result.daily[5].equity, 1000);
});

test("delayed sale cannot finance a rebalance before its real fill", () => {
  const result = run([
    window(0, 2, 1, [order("a", "A", fill(0), fill(3, 90))]),
    window(2, 4, 1, [order("b", "B", fill(2), fill(4))]),
    window(4, 5, 1, [order("c", "C", fill(4), fill(5))]),
  ]);
  assert.equal(result.unfundedOrders, 1);
  assert.deepEqual(
    result.closed.map((t) => t.order.symbol),
    ["A", "C"],
  );
  assert.equal(result.daily[2].cash, 0);
  assert.equal(result.daily[3].cash, 900);
  assert.equal(result.daily[5].equity, 900);
});

test("intraday proceeds cannot retroactively fund opening orders or waiting limits", () => {
  const result = run([
    window(0, 2, 1, [order("a", "A", fill(0), fill(2, 90, "intraday"))]),
    window(2, 5, 1, [order("b", "B", fill(3), fill(5))]),
  ]);
  assert.equal(result.unfundedOrders, 1);
  assert.equal(result.closed.length, 1);
  assert.equal(result.daily[2].cash, 900);
});

test("waiting limit reserves its original slot; fees are charged on actual notionals", () => {
  const result = run([
    window(0, 5, 2, [
      order("a", "A", fill(0), fill(1, 90, "intraday")),
      order("b", "B", fill(3), fill(5, 110), { buyFee: 0.01, sellFee: 0.02 }),
    ]),
  ]);
  assert.equal(result.daily[0].reservedCash, 500);
  assert.equal(result.daily[1].cash, 950);
  near(result.closed[1].qty, 500 / 101);
  near(result.daily[5].equity, 450 + (500 / 101) * 110 * 0.98);
  near(result.closed[1].netReturn, (110 * 0.98) / 101 - 1);
});

test("unresolved exits stay invested, missing closes keep last known mark and block duplicate holdings", () => {
  const result = run(
    [
      window(0, 2, 2, [order("a", "A", fill(0), null)]),
      window(2, 5, 1, [order("b", "A", fill(2), fill(5))]),
    ],
    (_, date) => (date === dates[0] ? 95 : null),
  );
  assert.equal(result.closed.length, 0);
  assert.equal(result.openPositions.length, 1);
  assert.equal(result.blockedByExistingPosition, 1);
  assert.equal(result.daily[5].equity, 975);
  assert.equal(result.daily[5].stalePositions, 1);
  assert.equal(result.openPositions[0].markDate, dates[0]);
});

test("same-bar limit-entry stop loses capital; invalid chronology is rejected", () => {
  const result = run([
    window(0, 5, 1, [
      order("a", "A", fill(0, 100, "intraday"), fill(0, 90, "intraday")),
    ]),
  ]);
  assert.equal(result.daily[0].equity, 900);
  assert.equal(result.maxDrawdownPct, 10);
  assert.throws(
    () => run([window(0, 5, 1, [order("b", "B", fill(1), fill(0))])]),
    /invalid_exit_fill/,
  );
  assert.equal(maxDrawdown([1000, 1200, 900, 1300], 1000), 25);
  assert.equal(dailySharpe([1000, 1000, 1000], 1000), null);
});
