import { test } from "node:test";
import assert from "node:assert/strict";
import { auditOfficial, buildEvents, parseExright, resumeEvents, rocToIso } from "./adj-events-lib.mjs";

test("ROC dates from both exchanges", () => {
  assert.equal(rocToIso("114年06月12日"), "2025-06-12");
  assert.equal(rocToIso("114/06/02"), "2025-06-02");
  assert.equal(rocToIso("1111003"), "2022-10-03");
  assert.equal(rocToIso("bad"), null);
});

test("ex-rights rows keep common stocks with positive prices only", () => {
  const rows = parseExright("tpex", [
    ["114/06/02", "6788", "華景電", "225.00", "215.00"],
    ["114/06/03", "00950B", "債券ETF", "13.25", "13.18"],
    ["114/06/04", "1234", "x", "--", "10.00"],
  ]);
  assert.deepEqual(rows, [["2025-06-02", "6788", 225, 215]]);
});

const twse = (rows) => Object.fromEntries([...rows, ...Array.from({ length: 501 }, (_, i) => [`F${i}`, [1, 1, 1, 1, 1, 0]])]);

test("X days are attributed to official events; unexplained jumps and prev mismatches are reported", () => {
  const days = new Map([
    ["2025-06-11", { twse: twse([["2330", [0, 0, 0, 1065, 1, 5]], ["9999", [0, 0, 0, 100, 1, 0]], ["8888", [0, 0, 0, 50, 1, 0]]]) }],
    // 2330 ex-dividend (X); 9999 -20% X with no official event (capital reduction?); 8888 normal day
    ["2025-06-12", { twse: twse([["2330", [0, 0, 0, 1045, 1, null]], ["9999", [0, 0, 0, 80, 1, null]], ["8888", [0, 0, 0, 51, 1, 1]]]) }],
  ]);
  const a = auditOfficial(days, [["2025-06-12", "2330", 1065, 1060.49], ["2025-06-12", "8888", 49, 48]]);
  assert.equal(a.stats.xDays, 2);
  assert.equal(a.stats.xExplained, 1);
  assert.deepEqual(a.unexplained.map((u) => u.sym), ["9999"]);
  assert.equal(a.stats.prevMismatch, 1);
  assert.deepEqual(a.mismatches, [{ sym: "8888", d: "2025-06-12", official: 49, daily: 50 }]);
  // legacy change-based method sees no event on the X day
  assert.equal(buildEvents(days).events.length, 0);
});

test("resume after suspension: split captured from change field, small no-trade noise and official days ignored", () => {
  const day = (rows) => ({ twse: twse(rows) });
  const days = new Map([
    ["2025-06-09", day([["0050", [0, 0, 0, 188.65, 1, 1]], ["6103", [0, 0, 0, 30, 1, 0]], ["2330", [0, 0, 0, 1000, 1, 5]]])],
    ["2025-06-10", day([["2330", [0, 0, 0, 1010, 1, 10]]])],
    // 0050 resumes after the split (+0.41 vs ref 47.16); 6103 resumes with a 30% gap vs reference noise; 2330 contiguous
    ["2025-06-18", day([["0050", [0, 0, 0, 47.57, 1, 0.41]], ["6103", [0, 0, 0, 39, 1, 0]], ["2330", [0, 0, 0, 500, 1, 0]]])],
  ]);
  assert.deepEqual(resumeEvents(days, new Set()), [["2025-06-18", "0050", 188.65, 47.16, "twse"]]);
  assert.deepEqual(resumeEvents(days, new Set(["0050|2025-06-18"])), []);
});
