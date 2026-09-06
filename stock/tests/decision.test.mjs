import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stopExit,
  nextSell,
} from "../supabase/functions/run-backtest/execution.ts";
import { validatePlan, taipeiDate } from "../lib/trade-plan.ts";
import { summarizeObservations } from "../lib/scan.ts";

const bar = (day, open = 100, high = 102, low = 98, close = 100) => ({
  trade_date: `2026-08-${String(day).padStart(2, "0")}`,
  open,
  high,
  low,
  close,
});
const seed = () => Array.from({ length: 16 }, (_, i) => bar(i + 1));
const options = { pct: 0, atr: 0, chandelier: 2, exitAtOpen: true };

test("an earlier stop remains valid when a future scheduled exit has no fill", () => {
  const bars = [...seed(), bar(17, 100, 102, 89, 90), bar(18, 81, 81, 81, 81)];
  const result = stopExit(bars, { date: "2026-08-16", price: 100 },
    { date: "2026-08-18", price: null }, { ...options, pct: 10, chandelier: 0, exitAtOpen: false });
  assert.equal(result.fill.date, "2026-08-17");
  assert.equal(result.fill.price, 90);
});

test("Chandelier cannot use today high to stop out earlier today", () => {
  const bars = [
    ...seed(),
    bar(17, 100, 130, 99, 120),
    bar(18, 120, 125, 118, 122),
  ];
  const result = stopExit(
    bars,
    { date: "2026-08-17", price: 100 },
    { date: "2026-08-18", price: 120 },
    options,
  );
  assert.equal(result.triggered, false);
});
test("opening entry is protected on the entry session; gap uses open", () => {
  const bars = [...seed(), bar(17, 100, 102, 85, 90), bar(18, 90)];
  const result = stopExit(
    bars,
    { date: "2026-08-17", price: 100 },
    { date: "2026-08-18", price: 90 },
    { ...options, pct: 10, chandelier: 0 },
  );
  assert.equal(result.fill.price, 90);
  assert.equal(result.fill.date, "2026-08-17");
  bars[16] = bar(17, 85, 90, 80, 85);
  assert.equal(
    stopExit(
      bars,
      { date: "2026-08-16", price: 100 },
      { date: "2026-08-18", price: 90 },
      { ...options, pct: 10, chandelier: 0 },
    ).fill.price,
    85,
  );
});
test("locked down has no fictional sell; wait for an executable opening", () => {
  const bars = [bar(1), bar(2, 90, 90, 90, 90), bar(3, 81, 81, 81, 81)];
  assert.equal(nextSell(bars, 1), null);
  bars.push(bar(4, 78, 80, 75, 79));
  assert.deepEqual(nextSell(bars, 1), { price: 78, date: "2026-08-04" });
});
test("scheduled opening exit ignores the later daily low", () => {
  const bars = [...seed(), bar(17, 110, 115, 50, 60)];
  const result = stopExit(
    bars,
    { date: "2026-08-16", price: 100 },
    { date: "2026-08-17", price: 110 },
    { ...options, pct: 10, chandelier: 0 },
  );
  assert.equal(result.triggered, false);
  assert.equal(result.fill.price, 110);
});
test("missing pre-entry ATR fails explicitly", () => {
  assert.equal(
    stopExit(
      [bar(1), bar(2)],
      { date: "2026-08-01", price: 100 },
      { date: "2026-08-02", price: 100 },
      options,
    ).error,
    "atr_seed_unavailable",
  );
});
test("plan rejects invalid ranges, infinity, impossible dates and empty rationale", () => {
  const f = new FormData();
  for (const [key, value] of Object.entries({
    symbol: "2330",
    signal_date: "2026-09-04",
    entry_min: "100",
    entry_max: "105",
    stop_price: "95",
    valid_until: "2026-09-10",
    entry_reason: "等待回測後再進場",
    exit_rule: "跌破支撐後執行退出",
  }))
    f.set(key, value);
  assert.equal(validatePlan(f, "2026-09-06").p_entry_max, 105);
  for (const [key, value] of [
    ["entry_max", "99"],
    ["stop_price", "Infinity"],
    ["valid_until", "2026-02-30"],
    ["signal_date", "2026-09-07"],
    ["entry_reason", ""],
  ]) {
    const before = f.get(key);
    f.set(key, value);
    assert.throws(() => validatePlan(f, "2026-09-06"));
    f.set(key, before);
  }
});
test("Taipei date crosses midnight before UTC", () =>
  assert.equal(taipeiDate(new Date("2026-09-05T17:00:00Z")), "2026-09-06"));
test("observation aggregation weights dates equally and excludes missing rows", () => {
  const r = (date, x, status = "settled") => ({
    scan_date: date,
    excess_pct: x,
    observation_status: status,
  });
  const s = summarizeObservations([
    r("a", 10),
    r("a", 10),
    r("b", -10),
    r("c", null, "missing_price"),
  ]);
  assert.equal(s.mean, 0);
  assert.equal(s.days, 2);
  assert.equal(s.missing, 1);
});
