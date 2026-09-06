import test from "node:test";
import assert from "node:assert/strict";
import { planDefaults, addDays } from "../lib/plan-defaults.ts";

const checks = [
  { label: "當日漲幅 ≥ 7%", pass: true },
  { label: "成交量 ≥ 5,000 張", pass: true },
  { label: "突破前 20 日高", pass: true },
  { label: "站上轉揚月線", pass: true },
  { label: "月線乖離 < 15%", pass: false },
];
const row = (over = {}) => ({
  symbol: "6924", name: "測試", industry_category: "電子工業",
  trade_date: "2026-09-04", close: 123, day_pct: 7.2, volume_lots: 6100,
  ma20: 114.95, ma20_gap_pct: 7, ma20_slope_pct: 1.2, high_20d: 121.5,
  rsi14: 62, ret_5d_pct: 9, score_surge: 34, score_position: 33,
  score_momentum: 25, score_total: 92, passes_all: false, fgn_net_5d: null,
  atr14: 5.46, ...over,
});
const opts = (over = {}) => ({
  today: "2026-09-06", atrStopMultiple: 2, checks, ...over,
});

test("entry band is close ±3%, capped by the scan's own +15% MA20 anti-chase rule", () => {
  const d = planDefaults(row(), opts());
  assert.equal(d.entryMin, 119.31); // 123 × 0.97
  assert.equal(d.entryMax, 126.69); // 123 × 1.03 < 114.95 × 1.15
  const capped = planDefaults(row({ close: 100, ma20: 88 }), opts());
  assert.equal(capped.entryMax, 101.2); // 88 × 1.15 beats 100 × 1.03
  assert.equal(capped.entryMin, 97);
});

test("stop takes the TIGHTER of ATR×multiple and MA20", () => {
  // MA20 114.95 is tighter than 123 − 2×5.46 = 112.08
  const byMa = planDefaults(row(), opts());
  assert.equal(byMa.stopPrice, 114.95);
  assert.match(byMa.stopBasis, /月線/);
  // ATR stop 24.9 − 2×0.96 = 22.98 is tighter than MA20 21.68
  const byAtr = planDefaults(
    row({ close: 24.9, ma20: 21.68, atr14: 0.96 }),
    opts(),
  );
  assert.equal(byAtr.stopPrice, 22.98);
  assert.match(byAtr.stopBasis, /ATR14×2/);
});

test("stop is always strictly below entry_min, as the table constraint requires", () => {
  // MA20 99 and ATR stop 99.8 both sit ABOVE entry_min 97 and must be clamped.
  const d = planDefaults(row({ close: 100, ma20: 99, atr14: 0.1 }), opts());
  assert.ok(d.stopPrice < d.entryMin, `${d.stopPrice} < ${d.entryMin}`);
  assert.equal(d.stopPrice, 96.03); // round2(97 × 0.99)
});

test("a stock already beyond the gap cap collapses to a single pullback price", () => {
  const d = planDefaults(row({ close: 100, ma20: 80 }), opts());
  assert.equal(d.entryMax, 92); // 80 × 1.15
  assert.equal(d.entryMin, 92); // band would start at 97, above the cap
  assert.ok(d.entryMax >= d.entryMin);
  assert.ok(d.stopPrice < d.entryMin);
  assert.ok(d.notes.some((n) => n.includes("防追高")));
});

test("missing ATR or MA20 degrades honestly instead of guessing", () => {
  const noAtr = planDefaults(row({ atr14: null }), opts());
  assert.equal(noAtr.stopPrice, 114.95);
  assert.match(noAtr.stopBasis, /月線/);
  const noSetting = planDefaults(row(), opts({ atrStopMultiple: null }));
  assert.equal(noSetting.stopPrice, 114.95);
  const neither = planDefaults(row({ atr14: null, ma20: null }), opts());
  assert.equal(neither.stopPrice, 109.77); // round2(119.31 × 0.92 = 109.7652)
  assert.ok(neither.notes.some((n) => n.includes("缺 ATR 與月線")));
  assert.ok(neither.notes.some((n) => n.includes("缺月線")));
});

test("no price means no suggestion at all", () => {
  assert.equal(planDefaults(row({ close: null }), opts()), null);
  assert.equal(planDefaults(row({ close: 0 }), opts()), null);
});

test("generated text satisfies the 5–1000 character DB constraint", () => {
  for (const r of [row(), row({ close: 100, ma20: 80 }), row({ atr14: null })]) {
    const d = planDefaults(r, opts());
    for (const text of [d.entryReason, d.exitRule]) {
      assert.ok(text.length >= 5 && text.length <= 1000, `len ${text.length}`);
    }
    assert.ok(d.entryReason.includes(r.trade_date));
    assert.ok(d.exitRule.includes(d.stopPrice.toFixed(2)));
  }
});

test("entry reason reports both matched and unmatched conditions", () => {
  const d = planDefaults(row(), opts());
  assert.ok(d.entryReason.includes("已符合：當日漲幅 ≥ 7%"));
  assert.ok(d.entryReason.includes("未符合：月線乖離 < 15%"));
  const allPass = planDefaults(
    row(),
    opts({ checks: checks.map((c) => ({ ...c, pass: true })) }),
  );
  assert.ok(!allPass.entryReason.includes("未符合"));
});

test("valid_until is 14 calendar days out and never before today", () => {
  const d = planDefaults(row(), opts());
  assert.equal(d.validUntil, "2026-09-20");
  assert.ok(d.validUntil >= "2026-09-06");
  assert.equal(addDays("2026-12-25", 14), "2027-01-08"); // year boundary
  assert.equal(addDays("2026-02-28", 1), "2026-03-01"); // non-leap year
});
