import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etfModel, fmtLots, fmtLotsSigned, tdccMetrics } from '../lib/chip-plus-view.ts';

const latest = {
  data_date: '2026-10-02',
  holders_total: 1010,
  big400_ratio: '41.00',
  big400_wow: '0.50',
  big1000_ratio: '20.00',
  big1000_wow: '-0.10',
  retail50_ratio: '29.50',
  retail50_wow: '-0.50',
  holders_wow: 10,
};
const week = (d, b1000, b400, r50, h) => ({ data_date: d, holders_total: h, big400_ratio: b400, big1000_ratio: b1000, retail50_ratio: r50 });

test('tdccMetrics builds four cards with current value, week-over-week change and an oldest-first series', () => {
  const weeks = [week('2026-10-02', '20.00', '41.00', '29.50', 1010), week('2026-09-25', '20.10', '40.50', '30.00', 1000), week('2026-09-18', null, '40.00', '30.50', 990)];
  const m = tdccMetrics(latest, weeks);
  assert.deepEqual(m.map((x) => x.key), ['big1000', 'big400', 'retail50', 'holders']);
  assert.deepEqual([m[0].value, m[0].deltaText, m[0].delta], ['20.00%', '-0.10 pp', -0.1]);
  assert.deepEqual([m[1].value, m[1].deltaText], ['41.00%', '+0.50 pp']);
  assert.deepEqual([m[3].value, m[3].deltaText], ['1,010 人', '+10 人']);
  assert.deepEqual(m[0].points, [{ as_of: '2026-09-25', value: 20.1 }, { as_of: '2026-10-02', value: 20 }], 'null weeks are skipped, order is oldest first');
  assert.equal(m[1].points.length, 3);
});

test('tdccMetrics: no data gives no cards; missing deltas render as a dash', () => {
  assert.deepEqual(tdccMetrics(null, []), []);
  const m = tdccMetrics({ ...latest, big1000_wow: null, holders_wow: null }, []);
  assert.equal(m[0].deltaText, '—');
  assert.equal(m[3].deltaText, '—');
  assert.deepEqual(m[0].points, []);
});

test('lot formatting converts shares to lots and signs changes', () => {
  assert.equal(fmtLots(2_500_000), '2,500');
  assert.equal(fmtLots(null), '—');
  assert.equal(fmtLotsSigned(1_000_000), '+1,000');
  assert.equal(fmtLotsSigned(-300_000), '-300');
  assert.equal(fmtLotsSigned(0), '0');
  assert.equal(fmtLotsSigned(undefined), '—');
});

const flow = { as_of_date: '2099-01-06', n_etf: 2, qty: 2_700_000, chg_1d: 200_000, chg_5d: 1_700_000, chg_20d: 1_700_000, n_buy_5d: 2, n_sell_5d: 0 };
const holderRows = [
  { etf_symbol: '00981A', data_date: '2099-01-06', quantity: 2_500_000, weight: 7, quantity_change: 0 },
  { etf_symbol: '00982A', data_date: '2099-01-06', quantity: 200_000, weight: 1, quantity_change: 200_000 },
  { etf_symbol: '00981A', data_date: '2099-01-05', quantity: 2_500_000, weight: 7, quantity_change: 1_000_000 },
  { etf_symbol: '00983A', data_date: '2099-01-06', quantity: 0, weight: 0, quantity_change: -100_000 }, // exited today
];

test('etfModel summarises the latest holders (quantity > 0 on the latest data date) and the 1 / 5 / 20 day flow', () => {
  const m = etfModel(flow, holderRows, { '00981A': '第一金主動投資1000', '00982A': '主動群益台灣強棒' });
  assert.equal(m.hasData, true);
  assert.equal(m.nEtf, 2);
  assert.equal(m.totalLots, '2,700');
  assert.deepEqual(m.windows.map((w) => [w.label, w.value]), [['近 1 日', '+200'], ['近 5 日', '+1,700'], ['近 20 日', '+1,700']]);
  assert.equal(m.buySell, '近 5 日 2 檔加碼、0 檔減碼');
  assert.deepEqual(m.holders.map((h) => [h.etf, h.name, h.lots, h.weight, h.changeLots]), [
    ['00981A', '第一金主動投資1000', '2,500', '7.00%', '0'],
    ['00982A', '主動群益台灣強棒', '200', '1.00%', '+200'],
  ]);
});

test('etfModel: no flow row means no data; an ETF that exited still counts as activity but not as a holder', () => {
  assert.equal(etfModel(null, [], {}).hasData, false);
  const exited = etfModel({ ...flow, n_etf: 0, qty: 0, chg_1d: -100_000, chg_5d: 0, chg_20d: 0, n_buy_5d: 0, n_sell_5d: 1 }, [holderRows[3]], {});
  assert.equal(exited.hasData, true);
  assert.deepEqual(exited.holders, []);
  assert.equal(exited.buySell, '近 5 日 0 檔加碼、1 檔減碼');
  const noName = etfModel(flow, holderRows, {});
  assert.equal(noName.holders[0].name, '');
});

test('etfModel keeps only the top five holders by quantity', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ etf_symbol: `0099${i}A`, data_date: '2099-01-06', quantity: (i + 1) * 1000, weight: 1, quantity_change: 0 }));
  const m = etfModel(flow, many, {});
  assert.equal(m.holders.length, 5);
  assert.equal(m.holders[0].etf, '00997A');
});
