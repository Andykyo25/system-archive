import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSnapshotRows,
  checkSnapshot,
  isThrottleMessage,
  listOf,
  redact,
  snapshotDate,
  taipeiToday,
  toIsoDate,
  withBackoff,
} from './lib.mjs';

const inv = (stockNo, todayQty, extra = {}) => ({
  date: '2026/10/06',
  stockNo,
  orderType: 'Stock',
  todayQty,
  tradableQty: todayQty,
  odd: { todayQty: 0 },
  ...extra,
});
const unr = (stockNo, costPrice, todayQty, profit = 0, loss = 0, extra = {}) => ({
  stockNo,
  orderType: 'Stock',
  costPrice,
  todayQty,
  unrealizedProfit: profit,
  unrealizedLoss: loss,
  ...extra,
});

test('toIsoDate accepts slash and dash, rejects junk and impossible dates', () => {
  assert.equal(toIsoDate('2026/10/06'), '2026-10-06');
  assert.equal(toIsoDate('2026-10-06'), '2026-10-06');
  assert.equal(toIsoDate('2026/02/30'), null);
  assert.equal(toIsoDate('20261006'), null);
  assert.equal(toIsoDate(undefined), null);
});

test('taipeiToday uses Asia/Taipei, not UTC', () => {
  assert.equal(taipeiToday(new Date('2026-10-06T17:00:00Z')), '2026-10-07');
  assert.equal(taipeiToday(new Date('2026-10-06T10:00:00Z')), '2026-10-06');
});

test('snapshotDate prefers the broker date, falls back to Taipei today', () => {
  assert.equal(snapshotDate([{ date: 'bad' }, { date: '2026/10/05' }]), '2026-10-05');
  assert.equal(snapshotDate([], new Date('2026-10-06T10:00:00Z')), '2026-10-06');
});

test('buildSnapshotRows maps a normal holding with weighted cost and pnl', () => {
  const rows = buildSnapshotRows('6460-26', [inv('2330', 2000)], [unr('2330', 600, 2000, 5000, 0)]);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0], raw: undefined },
    {
      account_no: '6460-26',
      symbol: '2330',
      order_type: 'Stock',
      board_qty: 2000,
      odd_qty: 0,
      tradable_qty: 2000,
      cost_price: 600,
      unrealized_pnl: 5000,
      raw: undefined,
    },
  );
  assert.equal(rows[0].raw.inventory.length, 1);
  assert.equal(rows[0].raw.unrealized.length, 1);
});

test('buildSnapshotRows keeps odd lots separate and skips empty inventory rows', () => {
  const rows = buildSnapshotRows(
    'a',
    [inv('0050', 0, { odd: { todayQty: 37 } }), inv('2317', 0), inv('00878', 1000)],
    [],
  );
  assert.deepEqual(rows.map((r) => [r.symbol, r.board_qty, r.odd_qty]), [
    ['0050', 0, 37],
    ['00878', 1000, 0],
  ]);
});

test('buildSnapshotRows merges duplicate keys and weights cost by quantity', () => {
  const rows = buildSnapshotRows(
    'a',
    [inv('2454', 1000), inv('2454', 3000)],
    [unr('2454', 100, 1000, 0, 200), unr('2454', 200, 3000, 900, 0)],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].board_qty, 4000);
  assert.equal(rows[0].tradable_qty, 4000);
  assert.equal(rows[0].cost_price, 175);
  assert.equal(rows[0].unrealized_pnl, 700);
  assert.equal(rows[0].raw.inventory.length, 2);
});

test('buildSnapshotRows leaves cost null when unrealized orderType does not match', () => {
  const rows = buildSnapshotRows('a', [inv('2330', 1000)], [unr('2330', 600, 1000, 0, 0, { orderType: 'Margin' })]);
  assert.equal(rows[0].cost_price, null);
  assert.equal(rows[0].unrealized_pnl, null);
});

test('buildSnapshotRows keeps different order types of one symbol apart', () => {
  const rows = buildSnapshotRows('a', [inv('2330', 1000), inv('2330', 2000, { orderType: 'Margin' })], []);
  assert.deepEqual(rows.map((r) => [r.order_type, r.board_qty]), [
    ['Stock', 1000],
    ['Margin', 2000],
  ]);
});

test('buildSnapshotRows fails loudly on unexpected shapes', () => {
  assert.throws(() => buildSnapshotRows('a', [inv('BAD SYMBOL', 1)], []), /unexpected stockNo/);
  assert.throws(() => buildSnapshotRows('a', [{ stockNo: '2330', orderType: 'Stock' }], []), /missing todayQty/);
  assert.throws(() => buildSnapshotRows('a', [inv('2330', 'abc')], []), /non-numeric todayQty/);
  assert.throws(() => buildSnapshotRows('a', [inv('2330', 1.5)], []), /non-integer todayQty/);
  assert.throws(() => buildSnapshotRows('a', [inv('2330', 1000)], [{ stockNo: '2330', orderType: 'Stock', todayQty: 1 }]), /missing costPrice/);
});

test('buildSnapshotRows on empty input returns no rows', () => {
  assert.deepEqual(buildSnapshotRows('a', [], []), []);
  assert.deepEqual(buildSnapshotRows('a', undefined, undefined), []);
});

test('listOf treats success and "no data" messages as results, other errors as failures', () => {
  assert.deepEqual(listOf({ isSuccess: true, data: [1] }), { ok: true, list: [1] });
  assert.deepEqual(listOf({ isSuccess: true }), { ok: true, list: [] });
  assert.deepEqual(listOf({ isSuccess: false, message: '查無資料' }), { ok: true, list: [] });
  assert.equal(listOf({ isSuccess: false, message: '此 API KEY 未授權該功能' }).ok, false);
  assert.equal(listOf(undefined).ok, false);
});

test('checkSnapshot rejects empty broker data while the system holds positions', () => {
  assert.equal(checkSnapshot({ rowCount: 0, systemOpenCount: 3 }).ok, false);
  assert.equal(checkSnapshot({ rowCount: 0, systemOpenCount: 3, allowEmpty: true }).ok, true);
  assert.equal(checkSnapshot({ rowCount: 0, systemOpenCount: 0 }).ok, true);
  assert.equal(checkSnapshot({ rowCount: 2, systemOpenCount: 3 }).ok, true);
});

test('isThrottleMessage recognises the broker traffic-control message', () => {
  assert.equal(isThrottleMessage('業務系統流量控管'), true);
  assert.equal(isThrottleMessage('Too Many Requests'), true);
  assert.equal(isThrottleMessage('此 API KEY 未授權該功能'), false);
  assert.equal(isThrottleMessage(undefined), false);
});

test('withBackoff retries throttled calls then returns the success', async () => {
  const waits = [];
  let calls = 0;
  const res = await withBackoff(
    () => {
      calls += 1;
      return calls < 3 ? { isSuccess: false, message: '業務系統流量控管' } : { isSuccess: true, data: [] };
    },
    { sleep: async (ms) => waits.push(ms) },
  );
  assert.equal(res.isSuccess, true);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 4000]);
});

test('withBackoff does not retry non-throttle failures and gives up after the last delay', async () => {
  let calls = 0;
  const bad = await withBackoff(() => {
    calls += 1;
    return { isSuccess: false, message: '未授權' };
  }, { sleep: async () => {} });
  assert.equal(bad.isSuccess, false);
  assert.equal(calls, 1);

  calls = 0;
  const waits = [];
  const stuck = await withBackoff(() => {
    calls += 1;
    return { isSuccess: false, message: '流量控管' };
  }, { sleep: async (ms) => waits.push(ms) });
  assert.equal(stuck.isSuccess, false);
  assert.equal(calls, 5);
  assert.deepEqual(waits, [2000, 4000, 8000, 16000]);
});

test('redact masks secrets and ignores very short or empty ones', () => {
  assert.equal(redact('login A123456789 failed with key sk-abc-123', ['A123456789', 'sk-abc-123', undefined, 'x']), 'login *** failed with key ***');
  assert.equal(redact('plain x text', ['x']), 'plain x text');
});
