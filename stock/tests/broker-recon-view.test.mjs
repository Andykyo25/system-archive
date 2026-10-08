import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inventorySummary,
  mmdd,
  settlementLine,
  settlementReconSummary,
  upcomingSettlements,
} from '../lib/broker-recon-view.ts';

const run = { snapshot_date: '2026-10-08', row_count: 1, fetched_at: '2026-10-08T00:55:25Z' };

test('inventorySummary: no snapshot, all match, empty-on-both-sides, and diffs', () => {
  assert.equal(inventorySummary(null, []).tone, 'none');
  assert.deepEqual(inventorySummary(run, [{ symbol: '3374', system_qty: 1000, broker_qty: 1000, status: 'match' }]), {
    tone: 'ok',
    headline: '1 檔一致',
    lines: [],
  });
  assert.equal(inventorySummary(run, []).headline, '券商與系統皆無持股');
  const out = inventorySummary(run, [
    { symbol: '3374', system_qty: 1000, broker_qty: 800, status: 'qty_diff' },
    { symbol: '2330', system_qty: '2000', broker_qty: null, status: 'missing_at_broker' },
    { symbol: '0050', system_qty: 1000, broker_qty: 1000, status: 'match' },
  ]);
  assert.equal(out.tone, 'warn');
  assert.equal(out.headline, '2 檔有差異');
  assert.deepEqual(out.lines, [
    '3374　系統 1,000／券商 800　數量不符',
    '2330　系統 2,000／券商 0　券商無此持股',
  ]);
});

test('upcomingSettlements: only settlement dates from today on, summed per date, sign = receive / pay', () => {
  const out = upcomingSettlements(
    [
      { settlement_date: '2026-10-08', total_settlement_amount: '376550.00' },
      { settlement_date: '2026-10-12', total_settlement_amount: '-493605.00' },
      { settlement_date: '2026-10-12', total_settlement_amount: '-100.00' },
      { settlement_date: '2026-10-07', total_settlement_amount: '999' }, // already settled
      { settlement_date: null, total_settlement_amount: null }, // no-trade day
    ],
    '2026-10-08',
  );
  assert.deepEqual(out.byDate, [
    { date: '2026-10-08', amount: 376550 },
    { date: '2026-10-12', amount: -493705 },
  ]);
  assert.equal(out.total, 376550 - 493705);
  assert.deepEqual(upcomingSettlements([], '2026-10-08'), { total: 0, byDate: [] });
});

test('settlementLine labels receive / pay with the absolute amount', () => {
  assert.equal(settlementLine('2026-10-12', -493605), '10/12　應付 493,605');
  assert.equal(settlementLine('2026-10-08', 376550), '10/08　應收 376,550');
  assert.equal(settlementLine('2026-10-09', 0), '10/09　無淨額');
  assert.equal(mmdd('2026-10-08'), '10/08');
});

test('settlementReconSummary: pending is not a diff, tax_diff shows the tax gap, newest first', () => {
  assert.equal(settlementReconSummary([]).tone, 'none');
  assert.deepEqual(
    settlementReconSummary([
      { trade_date: '2026-10-07', status: 'match', sell_tax_diff: 0 },
      { trade_date: '2026-10-08', status: 'pending', sell_tax_diff: 0 },
    ]),
    { tone: 'ok', headline: '近 2 日一致', lines: [] },
  );
  const out = settlementReconSummary([
    { trade_date: '2026-10-06', status: 'tax_diff', sell_tax_diff: '552' },
    { trade_date: '2026-10-07', status: 'fee_diff', sell_tax_diff: 0 },
    { trade_date: '2026-10-08', status: 'match', sell_tax_diff: 0 },
  ]);
  assert.equal(out.tone, 'warn');
  assert.equal(out.headline, '2 日有差異');
  assert.deepEqual(out.lines, ['10/07　手續費不符', '10/06　稅額不符（稅差 +552）']);
});
