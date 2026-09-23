import test from "node:test";
import assert from "node:assert/strict";
import { horizonStats, median, sortPicks, verdictCounts } from "../lib/track.ts";

const row = (over = {}) => ({
  system: "scan", pick_id: "x", pick_date: "2026-09-01", symbol: "2330", name: null,
  score: "85", pick_rank: null, tag: null, entry_px: "100",
  ret_5: null, ret_10: null, ret_20: null, exc_5: null, exc_10: null, exc_20: null,
  verdict_h: null, verdict_ret: null, verdict_exc: null, verdict: "pending",
  refreshed_at: "2026-09-23T07:30:00Z", ...over,
});

test("median handles odd, even and empty", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("horizonStats only counts rows settled at that horizon; numeric strings are parsed", () => {
  const rows = [
    row({ pick_date: "2026-09-01", ret_5: "4", exc_5: "1" }),
    row({ pick_date: "2026-09-01", ret_5: "-2", exc_5: "-3" }),
    row({ pick_date: "2026-09-02", ret_5: "1", exc_5: null }),
    row({ pick_date: "2026-09-03", ret_20: "9", exc_20: "5" }), // not a T+5 row
  ];
  const s = horizonStats(rows, 5);
  assert.equal(s.n, 3);
  assert.equal(s.days, 2);
  assert.equal(Math.round(s.upPct), 67);
  assert.equal(s.beatPct, 50); // the null-benchmark row is excluded from beat%
  assert.equal(s.medianRet, 1);
  assert.equal(horizonStats(rows, 10), null);
});

test("verdictCounts tallies every verdict", () => {
  const c = verdictCounts([row({ verdict: "win" }), row({ verdict: "loss" }), row({ verdict: "loss" })]);
  assert.deepEqual(c, { win: 1, lag: 0, up: 0, loss: 2, pending: 0 });
});

test("sortPicks best/worst order by verdict return, pending always last", () => {
  const rows = [
    row({ symbol: "A", verdict_ret: "-5" }),
    row({ symbol: "B", verdict_ret: null }),
    row({ symbol: "C", verdict_ret: "12" }),
    row({ symbol: "D", verdict_ret: "3" }),
  ];
  assert.deepEqual(sortPicks(rows, "best").map((r) => r.symbol), ["C", "D", "A", "B"]);
  assert.deepEqual(sortPicks(rows, "worst").map((r) => r.symbol), ["A", "D", "C", "B"]);
});
