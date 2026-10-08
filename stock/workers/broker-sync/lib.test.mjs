import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysIso,
  buildRealizedRows,
  buildSettlementRows,
  buildSnapshotRows,
  checkSnapshot,
  isThrottleMessage,
  listOf,
  objOf,
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

test('objOf: success keeps the object, no-data is ok-but-empty, anything else fails', () => {
  assert.deepEqual(objOf({ isSuccess: true, data: { a: 1 } }), { ok: true, data: { a: 1 } });
  assert.deepEqual(objOf({ isSuccess: true }), { ok: true, data: null });
  assert.deepEqual(objOf({ isSuccess: false, message: '查無資料' }), { ok: true, data: null });
  assert.deepEqual(objOf({ isSuccess: false, message: 'settle boom' }), {
    ok: false,
    message: 'settle boom',
  });
  assert.deepEqual(objOf(undefined), { ok: false, message: 'no response' });
});

const settleDay = (date, settlementDate, extra = {}) => ({
  date,
  settlementDate,
  buyValue: 735500,
  buyFee: 313,
  buySettlement: -1429513,
  buyTax: 0,
  sellValue: 770500,
  sellFee: 320,
  sellSettlement: 0,
  sellTax: 2309,
  totalBsValue: 1506000,
  totalFee: 633,
  totalSettlementAmount: -1429513,
  totalTax: 2309,
  currency: 'TWD',
  ...extra,
});

test('buildSettlementRows keys by query date and keeps empty days as null amounts', () => {
  const empty = { date: '2026/10/07', settlementDate: '', buyValue: '', totalSettlementAmount: undefined };
  const rows = buildSettlementRows('6460-26', {
    account: { branchNo: '6460', account: '26' },
    details: [settleDay('2026/10/05', '2026/10/07'), empty],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].query_date, '2026-10-05');
  assert.equal(rows[0].settlement_date, '2026-10-07');
  assert.equal(rows[0].total_settlement_amount, -1429513);
  assert.equal(rows[0].sell_tax, 2309);
  assert.equal(rows[0].currency, 'TWD');
  assert.equal(rows[1].query_date, '2026-10-07');
  assert.equal(rows[1].settlement_date, null);
  assert.equal(rows[1].buy_value, null);
  assert.equal(rows[1].total_settlement_amount, null);
  assert.equal(rows[1].currency, null);
});

test('buildSettlementRows accepts the snake_case settlement_date spelling from the Node.js docs', () => {
  const d = settleDay('2026/10/05', undefined, { settlement_date: '2026/10/07' });
  assert.equal(buildSettlementRows('a', { details: [d] })[0].settlement_date, '2026-10-07');
});

test('buildSettlementRows: no data is empty, a wrong shape or bad date throws', () => {
  assert.deepEqual(buildSettlementRows('a', null), []);
  assert.deepEqual(buildSettlementRows('a', { details: [] }), []);
  assert.throws(() => buildSettlementRows('a', { details: 'nope' }), /no details array/);
  assert.throws(() => buildSettlementRows('a', { details: [settleDay('garbage', '2026/10/07')] }), /unexpected settlement date/);
  assert.throws(() => buildSettlementRows('a', { details: [settleDay('2026/10/05', '2026/13/40')] }), /unexpected settlementDate/);
  assert.throws(() => buildSettlementRows('a', { details: [settleDay('2026/10/05', '2026/10/07', { buyFee: 'x' })] }), /non-numeric buyFee/);
});

const realized = (stockNo, extra = {}) => ({
  date: '2026/10/05',
  stockNo,
  buySell: 'Sell',
  filledQty: 1000,
  filledPrice: 36.5,
  orderType: 'Stock',
  realizedProfit: 36339,
  realizedLoss: 0,
  ...extra,
});

test('buildRealizedRows maps one row per record and does not dedupe', () => {
  const rows = buildRealizedRows('6460-26', [realized('1101'), realized('1101')]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { ...rows[0], raw: undefined },
    {
      account_no: '6460-26',
      data_date: '2026-10-05',
      symbol: '1101',
      buy_sell: 'Sell',
      order_type: 'Stock',
      filled_qty: 1000,
      filled_price: 36.5,
      realized_profit: 36339,
      realized_loss: 0,
      raw: undefined,
    },
  );
  assert.deepEqual(buildRealizedRows('a', []), []);
  assert.deepEqual(buildRealizedRows('a', undefined), []);
});

test('buildRealizedRows defaults missing profit/loss to 0 and rejects bad shapes', () => {
  const rows = buildRealizedRows('a', [realized('2330', { realizedProfit: undefined, realizedLoss: 500 })]);
  assert.equal(rows[0].realized_profit, 0);
  assert.equal(rows[0].realized_loss, 500);
  assert.equal(buildRealizedRows('a', [realized('2330', { date: undefined })])[0].data_date, null);
  assert.throws(() => buildRealizedRows('a', [realized('BAD!!!')]), /unexpected stockNo/);
  assert.throws(() => buildRealizedRows('a', [realized('2330', { date: 'garbage' })]), /unexpected realized date/);
  assert.throws(() => buildRealizedRows('a', [realized('2330', { filledQty: 1.5 })]), /non-integer filledQty/);
  assert.throws(() => buildRealizedRows('a', [realized('2330', { filledPrice: undefined })]), /missing filledPrice/);
});

test('addDaysIso does plain calendar arithmetic across month and year ends', () => {
  assert.equal(addDaysIso('2026-10-08', -14), '2026-09-24');
  assert.equal(addDaysIso('2026-01-05', -14), '2025-12-22');
  assert.equal(addDaysIso('2026-02-27', 3), '2026-03-02');
});
