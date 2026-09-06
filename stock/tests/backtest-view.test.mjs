import { test } from "node:test";
import assert from "node:assert/strict";
import { canOverlay, monthlyEquityReturns } from "../lib/backtest-view.ts";

const run = () => ({
  params: { benchmark_symbol: "0050" },
  summary: {
    execution_version: "daily-stop-v4",
    accounting_version: "daily-cash-ledger-v1",
    equity_dates: ["2026-07-30", "2026-07-31", "2026-08-03"],
    equity_curve: [1, 1.1, 0.99],
    benchmark_equity_curve: [1, 1, 1],
  },
});
test("curve comparison refuses mismatched dates, models and benchmarks", () => {
  assert.equal(canOverlay([run(), run()]), true);
  for (const field of ["execution_version", "accounting_version"]) {
    const other = run();
    other.summary[field] = "legacy";
    assert.equal(canOverlay([run(), other]), false);
  }
  const other = run();
  other.summary.equity_dates[1] = "2026-07-29";
  assert.equal(canOverlay([run(), other]), false);
  assert.equal(
    canOverlay([
      {
        ...run(),
        summary: { equity_curve: [1, 1.1], rebalance_dates: ["2026-07-31"] },
      },
    ]),
    false,
  );
  const benchmark = run();
  benchmark.summary.benchmark_equity_curve[1] = 1.05;
  assert.equal(canOverlay([run(), benchmark]), false);
});
test("monthly returns compound from marked equity including open positions", () => {
  const values = monthlyEquityReturns(run().summary);
  assert.ok(Math.abs(values[0].avg - 10) < 1e-9);
  assert.ok(Math.abs(values[1].avg + 10) < 1e-9);
  assert.equal(monthlyEquityReturns({ equity_curve: [1, 1.1] }), null);
});
