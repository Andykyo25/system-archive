import test from "node:test";
import assert from "node:assert/strict";
import {
  adviceText, compareReadings, dailyStats, isMarketHours, keyLevels, staticReadings, supplyAbove, toQuote, toSnapshot,
} from "../lib/intraday.ts";

const bars = (n = 70, over = {}) =>
  Array.from({ length: n }, (_, i) => ({ d: `2026-07-${String(i + 1).padStart(2, "0")}`, c: 100 + i, h: 101 + i, l: 99 + i, v: 1_000_000, f: 1, ...over }));

test("toQuote 用成交價;z 被 throttle 時退回五檔中價並標示", () => {
  const raw = { c: "4958", z: "509.5", y: "507", o: "510", h: "522", l: "498.5", v: "25190", a: "510_511_", f: "93_243_", b: "509_508_", g: "128_107_", tlong: "1" };
  const q = toQuote(raw);
  assert.equal(q.price, 509.5);
  assert.equal(q.priceIsMid, false);
  assert.equal(q.askTot, 336);
  assert.equal(q.bidTot, 235);
  assert.ok(Math.abs(q.ratio - 235 / 336) < 1e-9);
  const m = toQuote({ ...raw, z: "-" });
  assert.equal(m.price, 509.5); // (510+509)/2
  assert.equal(m.priceIsMid, true);
  assert.equal(toQuote({ c: "x", z: "-", a: "", b: "" }), null);
});

test("dailyStats:均線 / ATR / 還原價換算 / 不足 60 根回 null", () => {
  const s = dailyStats(bars());
  assert.equal(s.ma5, 167);
  assert.equal(s.ma20, 159.5);
  assert.equal(s.ma60, 139.5);
  assert.equal(s.atr14, 2);
  assert.equal(dailyStats(bars(59)), null);
  // 最新 adj_factor=0.5:還原價 = c*f,換回目前單位 = 還原均線 / 0.5
  const half = bars().map((b) => ({ ...b, f: 0.5 }));
  assert.equal(dailyStats(half).ma5, 167);
  assert.equal(dailyStats(bars(70, { h: null })).atr14, null);
});

test("supplyAbove:與 scan_supply_share 同口徑(收盤 > 現價 且 ≤ ×1.2 的量 / 全部量)", () => {
  const s = supplyAbove(bars(), 150);
  assert.ok(Math.abs(s.sharePct - (19 / 70) * 100) < 1e-9);
  assert.ok(s.bins.length > 0 && s.bins.length <= 3);
  assert.ok(s.bins.every((b, i, a) => i === 0 || a[i - 1].lo <= b.lo));
  assert.equal(supplyAbove(bars(), 999).sharePct, 0); // 創高:上方無量 → 0,不是 null
});

test("compareReadings:量縮 / 新低 / 基準缺漏", () => {
  const base = { t: Date.UTC(2026, 9, 1, 2, 38), price: 501, chgPct: -1.18, hi: 522, lo: 498.5, vol: 17473, ratio: 1.3, askTot: 585, bidTot: 786, priceIsMid: false };
  const cur = { ...base, t: Date.UTC(2026, 9, 1, 2, 48), price: 500, vol: 18353 };
  const r = compareReadings(cur, base).map((x) => x.text);
  assert.match(r[0], /10:38 相比:下跌 1、未破今日低點/);
  assert.match(r[1], /量縮/);
  assert.match(compareReadings({ ...cur, lo: 497 }, base)[0].text, /已創今日新低/);
  assert.deepEqual(compareReadings(cur, null), []);
  // 收盤後不下量能結論(量不變會被誤判成量縮)
  const closed = { ...cur, t: Date.UTC(2026, 9, 1, 6, 10) };
  assert.equal(compareReadings(closed, { ...base, t: Date.UTC(2026, 9, 1, 5, 50) }).length, 1);
  // 間隔不到 2 分鐘不下量能結論
  assert.equal(compareReadings({ ...cur, t: base.t + 60000 }, base).length, 1);
});

test("keyLevels / staticReadings 組合", () => {
  const a = {
    symbol: "4958", name: "臻鼎-KY", fetchedAt: Date.UTC(2026, 9, 1, 4, 0),
    quote: toQuote({ z: "160", y: "158", h: "162", l: "157", v: "1000", a: "161_162_", f: "10_10_", b: "160_159_", g: "30_30_" }),
    quoteError: null, fallback: null, daily: dailyStats(bars()), supply: supplyAbove(bars(), 160),
    verdict: null, holding: null, atrMultiple: 2,
  };
  const k = keyLevels(a);
  assert.equal(k.support, 159.5); // MA20 是現價下方最近的均線
  assert.equal(k.resistance, 167); // MA5 是現價上方最近的均線
  assert.equal(k.atrStop, 156);
  const text = staticReadings(a).map((r) => r.text).join("\n");
  assert.match(text, /買盤掛單較厚/);
  assert.match(text, /MA20/);
  assert.ok(toSnapshot(a).price === 160);
  assert.equal(toSnapshot({ ...a, quote: null }), null);
});

test("isMarketHours 以台北時間 09:00–13:35、週一至週五", () => {
  assert.equal(isMarketHours(Date.UTC(2026, 9, 1, 1, 0)), true); // 週四 09:00
  assert.equal(isMarketHours(Date.UTC(2026, 9, 1, 5, 36)), false); // 13:36
  assert.equal(isMarketHours(Date.UTC(2026, 9, 3, 2, 0)), false); // 週六
});

test("staticReadings:即時報價失敗時仍用快取價算均線與套牢", () => {
  const a = {
    symbol: "4958", name: null, fetchedAt: 1, quote: null, quoteError: "x",
    fallback: { price: 160, quotedAt: 1 }, daily: dailyStats(bars()), supply: supplyAbove(bars(), 160),
    verdict: null, holding: null, atrMultiple: 2,
  };
  const kinds = staticReadings(a).map((r) => r.kind);
  assert.deepEqual(kinds, ["ma", "supply"]); // 沒有區間 / 五檔(來自即時報價)
});

test("adviceText:看多名單 / 非名單 / 持股損益", () => {
  const base = {
    symbol: "4958", name: null, fetchedAt: 1,
    quote: toQuote({ z: "160", y: "158", a: "161_", f: "1_", b: "160_", g: "1_" }), quoteError: null, fallback: null,
    daily: dailyStats(bars()), supply: null, verdict: null, holding: null, atrMultiple: 2,
  };
  const none = adviceText(base);
  assert.match(none.flat, /不在今日看多名單/);
  assert.match(none.flat, /159.5/); // 觀察支撐 = MA20
  assert.equal(none.heldLabel, "若持有");
  assert.match(none.held[0], /停損參考 156/);
  const listed = adviceText({ ...base, verdict: { watchDate: "2026-09-30", entryMin: 150, entryMax: 165, stopPrice: 140, state: "block", reason: "今日曾跌破停損" } });
  assert.match(listed.flat, /停止進場,今日曾跌破停損/);
  assert.match(listed.flat, /進場區間 150–165,停損 140/);
  const pending = adviceText({ ...base, verdict: {watchDate:'2026-10-08',entryMin:150,entryMax:165,stopPrice:140,state:'ok',reason:null} });
  assert.match(pending.flat, /報價與進場條件待確認/);
  assert.doesNotMatch(pending.flat, /可進場/);
  const held = adviceText({ ...base, holding: { lots: 2, avgCost: 150 } });
  assert.equal(held.heldLabel, "已有持股");
  assert.equal(held.held[0], "2 張、均價 150、損益 +6.67%");
  const unified = adviceText({...base,holding:{lots:2,avgCost:150},holdingStop:135,holdingDecision:{state:'caution',label:'留意風險',headline:'先觀察風險變化，暫不加碼',reasons:['籌碼支持偏弱']}});
  assert.match(unified.held.join(' '), /暫不加碼/);
  assert.match(unified.held.join(' '), /停損參考 135/);
  assert.doesNotMatch(unified.held.join(' '), /停損參考 156/);
});
