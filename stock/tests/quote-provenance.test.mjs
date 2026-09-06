import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  quoteToRow,
  deduplicateQuotes,
} from "../supabase/functions/fetch-yahoo-intraday/quote.ts";

const receivedAt = "2026-09-04T02:00:00.000Z"; // Friday 10:00 Taipei
const quotedAt = "2026-09-04T01:45:00.000Z";
const quote = (overrides = {}) => ({
  c: "2330", z: "105", y: "100", tv: "42", d: "20260904",
  tlong: String(Date.parse(quotedAt)), ...overrides,
});

test("fetching a stuck quote does not refresh its provider timestamp", () => {
  const first = quoteToRow(quote(), receivedAt);
  const later = quoteToRow(quote(), "2026-09-04T03:00:00Z");
  assert.equal(first.quoted_at, quotedAt);
  assert.deepEqual(first, later);
  assert.equal(first.price, 105);
  assert.equal(first.change_pct, 5);
  assert.equal(first.volume, 42);
  assert.equal(first.source, "twse_mis");
  assert.equal(first.market_state, "REGULAR");
  assert.ok(Date.parse(receivedAt) - Date.parse(first.quoted_at) > 10 * 60 * 1000);
});

test("missing, malformed, future and wrong-day provider times are skipped", () => {
  for (const tlong of [undefined, "", "-", "garbage", "Infinity", "0", "-1",
    "1.5", "999999999999999999999", String(Date.parse(quotedAt) / 1000),
    String(Date.parse(receivedAt) + 1), String(Date.parse("2026-09-03T02:00:00Z"))]) {
    assert.equal(quoteToRow(quote({ tlong }), receivedAt), null, String(tlong));
  }
  assert.equal(quoteToRow(quote(), "invalid date"), null);
  assert.equal(quoteToRow(quote({ d: "20260903" }), receivedAt), null);
  assert.equal(quoteToRow(quote({ d: "20260230" }), receivedAt), null);
  assert.equal(quoteToRow(quote({ d: "" }), receivedAt), null);
  assert.equal(quoteToRow(quote({ d: undefined }), receivedAt).quoted_at, quotedAt);
});

test("date consistency uses Taipei date across a UTC date boundary", () => {
  const row = quoteToRow(quote({
    d: "20260904", tlong: String(Date.parse("2026-09-03T23:30:00Z")),
  }), "2026-09-04T00:05:00Z");
  assert.equal(row.quoted_at, "2026-09-03T23:30:00.000Z");
  assert.equal(row.market_state, null);
  assert.equal(quoteToRow(quote({
    d: "20260903", tlong: String(Date.parse("2026-09-03T15:59:59Z")),
  }), "2026-09-03T16:00:01Z"), null);
});

test("order-book midpoint retains distinct provenance and the provider time", () => {
  const row = quoteToRow(quote({ z: "-", a: "106_107_", b: "104_103_" }), receivedAt);
  assert.equal(row.price, 105);
  assert.equal(row.source, "twse_mis_mid");
  assert.equal(row.quoted_at, quotedAt);
  assert.equal(quoteToRow(quote({ z: "-", a: "106_", b: "-" }), receivedAt), null);
  assert.equal(quoteToRow(quote({ z: "-", pz: "105" }), receivedAt), null);
});

test("a price alone cannot certify regular trading outside session hours", () => {
  for (const [time, date] of [
    ["2026-09-04T00:59:00Z", "20260904"],
    ["2026-09-04T05:30:01Z", "20260904"],
    ["2026-09-05T02:00:00Z", "20260905"],
  ]) {
    assert.equal(quoteToRow(quote({ tlong: String(Date.parse(time)), d: date }), time).market_state, null);
  }
  assert.equal(quoteToRow(quote(), "2026-09-04T05:31:00Z").market_state, null);
  for (const time of ["2026-09-04T01:00:00Z", "2026-09-04T05:30:00Z"]) {
    assert.equal(quoteToRow(quote({ tlong: String(Date.parse(time)) }), time).market_state, "REGULAR");
  }
});

test("duplicate provider timestamps produce a valid batch upsert, preferring trades", async () => {
  const trade = quoteToRow(quote(), receivedAt);
  const midpoint = quoteToRow(quote({ z: "-", a: "110_", b: "108_" }), receivedAt);
  const later = quoteToRow(quote({ tlong: String(Date.parse(quotedAt) + 1000) }), receivedAt);
  const rows = deduplicateQuotes([midpoint, trade, midpoint, trade, later]);
  assert.deepEqual(rows, [trade, later]);
  assert.deepEqual(deduplicateQuotes([trade, midpoint]), [trade]);
  const db = new PGlite();
  try {
    await db.exec(`create table cache (
      symbol text, quoted_at timestamptz, price numeric, source text,
      primary key(symbol, quoted_at)
    )`);
    const write = () => db.query(`
      insert into cache select * from jsonb_to_recordset($1::jsonb)
        as q(symbol text, quoted_at timestamptz, price numeric, source text)
      on conflict(symbol, quoted_at) do update set price=excluded.price, source=excluded.source
    `, [JSON.stringify(rows)]);
    await write();
    await write(); // a subsequent fetch with the same provider timestamp is safe
    const result = await db.query("select count(*)::int as n, min(price)::float8 as price from cache");
    assert.deepEqual(result.rows, [{ n: 2, price: 105 }]);
  } finally {
    await db.close();
  }
});
