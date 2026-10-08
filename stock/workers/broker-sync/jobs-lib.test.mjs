import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bucket,
  etfRows,
  etfTasks,
  instRows,
  instTasks,
  isNoData,
  isRateLimit,
  minuteCompact,
  pendingTasks,
  tdccRange,
  tdccRows,
  tdccSummary,
  tdccTasks,
  windows,
} from './jobs-lib.mjs';

const RANGES = [
  '1-999', '1000-5000', '5001-10000', '10001-15000', '15001-20000', '20001-30000', '30001-40000', '40001-50000',
  '50001-100000', '100001-200000', '200001-400000', '400001-600000', '600001-800000', '800001-1000000', '1000001以上',
];
const SHARES = [100, 100, 100, 100, 100, 100, 100, 100, 200, 200, 200, 500, 300, 200, 1000];
const dist = (extra = []) => [
  ...RANGES.map((range, i) => ({ range, holders: 10, shares: SHARES[i], proportion: 0 })),
  { range: '合計', holders: 150, shares: 3400, proportion: 100 },
  ...extra,
];

test('tdccSummary derives big-holder and retail ratios from the level rows', () => {
  assert.deepEqual(tdccSummary(dist()), {
    holders_total: 150,
    shares_total: 3400,
    big400_holders: 40,
    big400_ratio: 58.82,
    big1000_holders: 10,
    big1000_ratio: 29.41,
    retail50_holders: 80,
    retail50_ratio: 23.53,
  });
});

test('tdccSummary ignores the adjustment row, accepts thousands separators, falls back to level sums without a total row', () => {
  const withAdj = dist([{ range: '異動', holders: 0, shares: -5, proportion: 0 }]);
  assert.equal(tdccSummary(withAdj).big400_ratio, 58.82);
  const commas = dist().map((r) => (r.range === '1000-5000' ? { ...r, range: '1,000-5,000' } : r));
  assert.equal(tdccSummary(commas).retail50_holders, 80);
  const noTotal = dist().filter((r) => r.range !== '合計');
  assert.equal(tdccSummary(noTotal).holders_total, 150);
  assert.equal(tdccSummary(noTotal).shares_total, 3400);
});

test('tdccSummary fails loudly on unexpected shapes', () => {
  assert.throws(() => tdccSummary(undefined), /not an array/);
  assert.throws(() => tdccSummary(dist().slice(0, 5)), /only \d+ level rows/);
  assert.throws(() => tdccSummary(dist().map((r) => (r.range === '合計' ? { ...r, shares: 0 } : r))), /zero custody total/);
  assert.throws(() => tdccSummary(dist().map((r, i) => (i === 3 ? { ...r, holders: 'x' } : r))), /bad tdcc holders/);
});

test('tdccRows maps every period; tdccRange backfills a year or tops up from 14 days before the last date', () => {
  const rows = tdccRows('2330', { data: [{ date: '2026-10-02', distributions: dist() }, { date: '2026-09-25', distributions: dist() }] });
  assert.deepEqual(rows.map((r) => [r.symbol, r.data_date]), [['2330', '2026-10-02'], ['2330', '2026-09-25']]);
  assert.throws(() => tdccRows('2330', { data: [{ date: 'junk', distributions: dist() }] }), /bad date/);
  assert.throws(() => tdccRows('2330', {}), /no data array/);
  assert.deepEqual(tdccRange(null, '2026-10-08'), { from: '2025-10-09', to: '2026-10-08' });
  assert.deepEqual(tdccRange('2026-10-02', '2026-10-08'), { from: '2026-09-18', to: '2026-10-08' });
});

const comp = (symbol, quantity, weight, extra = {}) => ({ symbol, name: symbol, quantity, weight, ...extra });

test('etfRows diffs consecutive days, adds closing rows for exits, drops foreign components, sorts days', () => {
  const res = {
    data: [
      { date: '2026-10-02', components: [comp('2330', 1500, 6), comp('2317', 300, 2), comp('AAPL UQ', 50, 1)] },
      { date: '2026-10-01', components: [comp('2330', 1000, 5, { quantityChange: 111, weightChange: 9 }), comp('2317', 300, 2), comp('2454', 100, 1)] },
      { date: '2026-10-03', components: [comp('2330', 1500, 6), comp('3711', 400, 3)] },
    ],
  };
  const rows = etfRows('00981A', res);
  const pick = (d, s) => rows.find((r) => r.data_date === d && r.symbol === s);
  // first day: no previous day in the window → API values pass through
  assert.deepEqual(pick('2026-10-01', '2330'), { etf_symbol: '00981A', data_date: '2026-10-01', symbol: '2330', quantity: 1000, weight: 5, quantity_change: 111, weight_change: 9 });
  assert.equal(pick('2026-10-01', '2454').quantity_change, null);
  // day 2: 2330 +500, 2317 unchanged; 2454 dropped → closing row
  assert.equal(pick('2026-10-02', '2330').quantity_change, 500);
  assert.equal(pick('2026-10-02', '2330').weight_change, 1);
  assert.equal(pick('2026-10-02', '2317').quantity_change, 0);
  assert.deepEqual(pick('2026-10-02', '2454'), { etf_symbol: '00981A', data_date: '2026-10-02', symbol: '2454', quantity: 0, weight: 0, quantity_change: -100, weight_change: -1 });
  // day 3: 3711 is new (change = full quantity), 2317 exits
  assert.equal(pick('2026-10-03', '3711').quantity_change, 400);
  assert.equal(pick('2026-10-03', '2317').quantity, 0);
  assert.equal(pick('2026-10-03', '2317').quantity_change, -300);
  // the exited 2454 is not written again on day 3, and the foreign component never appears
  assert.equal(pick('2026-10-03', '2454'), undefined);
  assert.ok(!rows.some((r) => r.symbol.includes('AAPL')));
});

test('etfRows with a baselineDate uses that day only as the base and does not re-emit it', () => {
  const res = { data: [{ date: '2026-10-01', components: [comp('2330', 1000, 5)] }, { date: '2026-10-02', components: [comp('2330', 1200, 5.5), comp('2317', 10, 1)] }] };
  const rows = etfRows('00400A', res, { baselineDate: '2026-10-01' });
  assert.deepEqual(rows.map((r) => [r.data_date, r.symbol, r.quantity_change]), [['2026-10-02', '2330', 200], ['2026-10-02', '2317', 10]]);
  assert.equal(rows[0].weight_change, 0.5);
});

test('etfRows fails loudly on unexpected shapes', () => {
  assert.throws(() => etfRows('X', {}), /no data array/);
  assert.throws(() => etfRows('X', { data: [{ date: '2026-10-01', components: 'nope' }] }), /components is not an array/);
  assert.throws(() => etfRows('X', { data: [{ date: '2026-10-01', components: [comp('2330', 'x', 1)] }] }), /bad etf quantity/);
  assert.deepEqual(etfRows('X', { data: [] }), []);
});

test('instRows maps net buy / sell per institution and adds the total', () => {
  const rows = instRows('2330', { data: [{ date: '2013-01-02', foreign: { buy: 5, sell: 2, net: 3 }, trust: { buy: 0, sell: 1, net: -1 }, dealer: { buy: 4, sell: 0, net: 4 }, total: 6 }] });
  assert.deepEqual(rows, [{ symbol: '2330', trade_date: '2013-01-02', foreign_net: 3, trust_net: -1, dealer_net: 4, total_net: 6 }]);
  assert.throws(() => instRows('2330', { data: [{ date: '2013-01-02', foreign: {}, trust: { net: 1 }, dealer: { net: 1 } }] }), /bad inst foreign\.net/);
  assert.deepEqual(instRows('2330', { data: [] }), []);
});

test('windows splits ranges under one year with one-day overlap', () => {
  assert.deepEqual(windows('2025-01-01', '2026-10-08'), [
    { from: '2025-01-01', to: '2025-12-27' },
    { from: '2025-12-27', to: '2026-10-08' },
  ]);
  assert.deepEqual(windows('2026-09-01', '2026-10-08'), [{ from: '2026-09-01', to: '2026-10-08' }]);
  assert.deepEqual(windows('2026-10-09', '2026-10-08'), []);
  for (const w of windows('2013-01-01', '2026-10-08')) assert.ok((Date.parse(w.to) - Date.parse(w.from)) / 86400000 < 365);
});

test('task lists are deterministic: per-3-day tdcc, per-day etf, newest-year-first inst with a weekly key for the current year', () => {
  assert.equal(bucket('2026-10-08', 3), bucket('2026-10-08', 3));
  assert.equal(tdccTasks(['2330', 'bad!'], '2026-10-08').length, 1);
  assert.equal(tdccTasks(['2330'], '2026-10-08')[0].key, `tdcc|2330|${bucket('2026-10-08', 3)}`);
  assert.notEqual(tdccTasks(['2330'], '2026-10-08')[0].key, tdccTasks(['2330'], '2026-10-11')[0].key);
  assert.deepEqual(etfTasks(['00981A', '00981D', '0050'], '2026-10-08').map((t) => t.key), ['etf|00981A|2026-10-08']);
  const t = instTasks(['2330', '2317'], '2026-10-08');
  assert.equal(t.length, 2 * 14);
  assert.deepEqual([t[0].symbol, t[0].from, t[0].to], ['2330', '2026-01-01', '2026-10-08']);
  assert.match(t[0].key, /^inst\|2330\|2026\|w\d+$/);
  assert.deepEqual([t[2].key, t[2].from, t[2].to], ['inst|2330|2025', '2025-01-01', '2025-12-31']);
  assert.equal(t.at(-1).key, 'inst|2317|2013');
});

test('pendingTasks skips finished tasks and retries failed ones only after 3 days', () => {
  const tasks = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }];
  const now = Date.parse('2026-10-08T00:00:00Z');
  const done = [
    { task_key: 'a', rows_written: 5, done_at: '2026-10-07T00:00:00Z' },
    { task_key: 'b', rows_written: -1, done_at: '2026-10-07T00:00:00Z' }, // failed yesterday
    { task_key: 'c', rows_written: -1, done_at: '2026-10-01T00:00:00Z' }, // failed a week ago
  ];
  assert.deepEqual(pendingTasks(tasks, done, now).map((t) => t.key), ['c', 'd']);
});

test('minuteCompact keeps per-minute highs and lows, not the bars; empty and malformed input are safe', () => {
  const res = { data: [
    { date: '2026-10-07T09:01:00.000+08:00', open: 101, high: 102, low: 100.5, close: 101.5 },
    { date: '2026-10-07T09:00:00.000+08:00', open: 100, high: 101, low: 99.5, close: 100.5 },
    { date: '2026-10-07T13:30:00.000+08:00', open: 103, high: 104, low: 102, close: 103.5 },
    { date: 'x', open: null, high: 1, low: 1, close: 1 },
  ] };
  assert.deepEqual(minuteCompact(res), { bars: 3, open: 100, high: 104, low: 99.5, close: 103.5, highs: [101, 102, 104], lows: [99.5, 100.5, 102], t0: '09:00' });
  assert.deepEqual(minuteCompact({ data: [] }), { bars: 0, open: null, high: null, low: null, close: null, highs: [], lows: [], t0: null });
  assert.throws(() => minuteCompact({}), /no data array/);
});

test('isRateLimit / isNoData recognise the common error texts', () => {
  assert.ok(isRateLimit(new Error('{"statusCode":429,"message":"Rate limit exceeded"}')));
  assert.ok(isRateLimit('Too Many Requests'));
  assert.ok(!isRateLimit(new Error('boom')));
  assert.ok(isNoData(new Error('Resource Not Found (404)')));
  assert.ok(!isNoData(new Error('boom')));
});

test('etfRows sums duplicate lines of the same stock on the same day so primary keys stay unique', () => {
  const res = { data: [
    { date: '2026-10-01', components: [comp('2330', 1000, 5), comp('2330', 500, 2)] },
    { date: '2026-10-02', components: [comp('2330', 1000, 5), comp('2330', 700, 2.5)] },
  ] };
  const rows = etfRows('00400A', res);
  assert.equal(new Set(rows.map((r) => `${r.etf_symbol}|${r.data_date}|${r.symbol}`)).size, rows.length, 'no duplicate keys');
  assert.deepEqual(rows.map((r) => [r.data_date, r.quantity, r.weight, r.quantity_change, r.weight_change]), [
    ['2026-10-01', 1500, 7, null, null],
    ['2026-10-02', 1700, 7.5, 200, 0.5],
  ]);
});
