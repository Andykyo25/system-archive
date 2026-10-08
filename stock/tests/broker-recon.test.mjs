import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  alertId,
  formatMessage,
  inventoryAlerts,
  pickNew,
  sampleMessage,
  settlementAlerts,
  syncAlerts,
  taipeiDate,
} from '../supabase/functions/_shared/broker-recon.ts';

const inv = (status, extra = {}) => ({
  snapshot_date: '2026-10-08',
  symbol: '3374',
  system_qty: 1000,
  broker_qty: 800,
  system_avg_cost: '493.5',
  broker_avg_cost: '520.1',
  status,
  ...extra,
});
const stl = (trade_date, status, extra = {}) => ({
  trade_date,
  status,
  buy_value_diff: '0',
  sell_value_diff: '0',
  buy_fee_diff: '0',
  sell_fee_diff: '0',
  system_sell_tax: '2262',
  broker_sell_tax: '1710',
  sell_tax_diff: '552',
  broker_buy_value: '375500',
  broker_sell_value: '754000',
  ...extra,
});

test('taipeiDate and addDays use Taipei calendar days', () => {
  assert.equal(taipeiDate(new Date('2026-10-08T17:00:00Z')), '2026-10-09');
  assert.equal(taipeiDate(new Date('2026-10-08T10:30:00Z')), '2026-10-08');
  assert.equal(addDays('2026-10-02', -3), '2026-09-29');
  assert.equal(addDays('2026-01-01', -3), '2025-12-29');
});

test('inventoryAlerts: only today snapshots, only non-match, one readable line per status', () => {
  assert.deepEqual(inventoryAlerts([inv('match')], '2026-10-08'), []);
  assert.deepEqual(inventoryAlerts([inv('qty_diff', { snapshot_date: '2026-10-07' })], '2026-10-08'), []);
  const lines = Object.fromEntries(
    ['qty_diff', 'missing_in_system', 'missing_at_broker', 'cost_diff'].map((s) => [s, inventoryAlerts([inv(s)], '2026-10-08')[0]]),
  );
  assert.match(lines.qty_diff.line, /系統 1,000 股／券商 800 股/);
  assert.match(lines.missing_in_system.line, /券商有 800 股，系統沒有紀錄/);
  assert.match(lines.missing_at_broker.line, /系統有 1,000 股，券商沒有/);
  assert.match(lines.cost_diff.line, /系統 493\.5／券商 520\.1/);
  // the key carries the snapshot date so an unresolved diff re-alerts the next day
  assert.equal(lines.qty_diff.key, '3374@2026-10-08');
  assert.equal(inventoryAlerts([inv('qty_diff', { snapshot_date: '2026-10-09' })], '2026-10-09')[0].key, '3374@2026-10-09');
});

test('settlementAlerts: 3-day window, match / pending are silent, tax_diff names the likely cause', () => {
  const rows = [
    stl('2026-10-06', 'tax_diff'),
    stl('2026-10-07', 'match'),
    stl('2026-10-08', 'pending'),
    stl('2026-10-02', 'tax_diff'), // older than 3 days
    stl('2026-10-09', 'tax_diff'), // future relative to today
  ];
  const out = settlementAlerts(rows, '2026-10-08');
  assert.equal(out.length, 1);
  assert.equal(out[0].key, '2026-10-06');
  assert.match(out[0].line, /交割款 10\/06：賣出稅 系統 2,262／券商 1,710（差 \+552），可能是當沖半稅沒記/);
});

test('settlementAlerts: value / fee / missing statuses each produce a line', () => {
  const t = (status, extra) => settlementAlerts([stl('2026-10-08', status, extra)], '2026-10-08')[0].line;
  assert.match(t('value_diff', { buy_value_diff: '-1000', sell_value_diff: '0' }), /買進金額差 -1,000、賣出金額差 0/);
  assert.match(t('fee_diff', { buy_fee_diff: '5', sell_fee_diff: '0' }), /手續費差 買 \+5／賣 0/);
  assert.match(t('missing_in_system'), /券商有成交（買 375,500／賣 754,000），系統沒有紀錄/);
  assert.match(t('missing_at_broker'), /系統有交易，券商沒有成交/);
});

test('syncAlerts: none when the latest run succeeded; missing and failed are each reported once per day', () => {
  const ok = { started_at: '2026-10-08T10:00:00Z', success: true, error: null };
  const bad = { started_at: '2026-10-08T10:00:05Z', success: false, error: 'partial: querySettlement: boom' };
  assert.deepEqual(syncAlerts([ok], '2026-10-08'), []);
  assert.deepEqual(syncAlerts([ok, bad], '2026-10-08').map((a) => [a.key, a.status]), [['2026-10-08', 'failed']]);
  assert.match(syncAlerts([bad], '2026-10-08')[0].line, /最近一次同步失敗：partial: querySettlement: boom/);
  assert.deepEqual(syncAlerts([bad, ok].map((r, i) => ({ ...r, started_at: i ? '2026-10-08T10:09:00Z' : r.started_at })), '2026-10-08'), []);
  assert.deepEqual(syncAlerts([], '2026-10-08').map((a) => a.status), ['missing']);
  assert.match(syncAlerts([{ started_at: 'x', success: null, error: null }], '2026-10-08')[0].line, /未知原因/);
});

test('pickNew drops alerts that were already sent; ids differ by kind, key and status', () => {
  const a = settlementAlerts([stl('2026-10-06', 'tax_diff')], '2026-10-08')[0];
  const b = settlementAlerts([stl('2026-10-06', 'fee_diff')], '2026-10-08')[0];
  const sent = new Set([alertId(a)]);
  assert.deepEqual(pickNew([a, b], sent), [b]);
  assert.deepEqual(pickNew([a], new Set()), [a]);
  assert.notEqual(alertId(a), alertId(b));
});

test('formatMessage: header, sync first then inventory then settlement, plain text only', () => {
  const alerts = [
    ...settlementAlerts([stl('2026-10-06', 'tax_diff')], '2026-10-08'),
    ...inventoryAlerts([inv('qty_diff')], '2026-10-08'),
    ...syncAlerts([], '2026-10-08'),
  ];
  const msg = formatMessage(alerts, '2026-10-08');
  const lines = msg.split('\n');
  assert.equal(lines[0], '⚠️ 券商對帳異常（2026-10-08）');
  assert.match(lines[1], /^• broker-sync/);
  assert.match(lines[2], /^• 持股 3374/);
  assert.match(lines[3], /^• 交割款 10\/06/);
  assert.match(lines[4], /詳見 \/holdings/);
  assert.ok(!msg.includes('\\'), 'plain text: no markdown escaping is needed because parse_mode is not used');
});

test('sampleMessage is deterministic and covers every status template', () => {
  const msg = sampleMessage();
  assert.equal(msg, sampleMessage());
  for (const re of [/broker-sync：近 3 小時沒有執行紀錄/, /最近一次同步失敗/, /數量不符/, /漏記買進/, /漏記賣出/, /差異超過 1%/, /當沖半稅沒記/, /買進金額差/, /手續費差/, /系統沒有紀錄/, /券商沒有成交/]) {
    assert.match(msg, re);
  }
  assert.match(msg, /^⚠️ 券商對帳異常（2026-01-02）/);
});
