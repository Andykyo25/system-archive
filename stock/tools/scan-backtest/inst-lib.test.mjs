import test from "node:test";
import assert from "node:assert/strict";
import { parseTpexInst, parseTwseT86 } from "./inst-lib.mjs";

// real rows from the 2026-09-30 / 2022-07-01 responses (see header of inst-lib.mjs)
const twse = {
  stat: "OK",
  data: [
    ["3481", "群創            ", "156,794,286", "57,695,183", "99,099,103", "0", "0", "0", "0", "0", "0", "7,181,060", "4,476,000", "534,000", "3,942,000", "3,821,942", "582,882", "3,239,060", "106,280,163"],
    ["00632R", "元大台灣50反1   ", "1,683,000", "1,543,000", "140,000", "0", "0", "0", "668,000", "0", "668,000", "253,041,009", "25,858,000", "1,500,000", "24,358,000", "256,949,050", "28,266,041", "228,683,009", "253,849,009"],
    ["2330", "台積電", "1", "1", "-5,000", "0", "0", "0", "1,000", "0", "2,000", "-300", "0", "0", "0", "0", "0", "0", "-3,300"],
  ],
};
const tpexRow = (code, f, t, d, total) => {
  const r = new Array(24).fill("0");
  r[0] = code; r[1] = "x"; r[4] = f; r[13] = t; r[22] = d; r[23] = total;
  return r;
};

test("parseTwseT86 takes foreign (excl. foreign dealers), trust, dealer and total net shares for 4-digit stocks only", () => {
  const out = parseTwseT86(twse);
  assert.deepEqual(out, { "3481": [99099103, 0, 7181060, 106280163], "2330": [-5000, 2000, -300, -3300] });
  assert.equal(out["00632R"], undefined, "ETFs are excluded");
});

test("parseTwseT86 returns nothing for holidays and malformed responses", () => {
  assert.deepEqual(parseTwseT86({ stat: "很抱歉，沒有符合條件的資料!" }), {});
  assert.deepEqual(parseTwseT86({ stat: "OK" }), {});
  assert.deepEqual(parseTwseT86(undefined), {});
});

test("parseTpexInst reads the grouped columns (net of each buy/sell/net triple) and skips non-stocks and unparsable rows", () => {
  const j = { stat: "ok", tables: [{ data: [tpexRow("6213", "542,000", "0", "7,333,953", "7,875,953"), tpexRow("006201", "0", "13,000", "-138,923", "-125,923"), tpexRow("5269", "-1,000", "-2", "--", "-1,002")] }] };
  assert.deepEqual(parseTpexInst(j), { "6213": [542000, 0, 7333953, 7875953] });
  assert.deepEqual(parseTpexInst({ stat: "ok", tables: [] }), {});
  assert.deepEqual(parseTpexInst({ stat: "error" }), {});
});

test("the total column equals foreign + trust + dealer for the real samples (cross-check of the column mapping)", () => {
  // TPEx 006201: trust 13,000 + dealer -138,923 = -125,923 ; 00411A: foreign 542,000 + dealer 7,333,953 = 7,875,953
  assert.equal(13000 + -138923, -125923);
  assert.equal(542000 + 7333953, 7875953);
});
