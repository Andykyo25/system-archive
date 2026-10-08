import test from 'node:test';
import assert from 'node:assert/strict';
import {formatPriceTimestamp} from '../app/_components/Format.ts';

test('provider quote tooltip uses Taipei time on UTC deployment hosts', t=>{
  t.mock.method(Date,'now',()=>Date.parse('2026-10-08T07:30:00Z'));
  const r=formatPriceTimestamp('2026-10-08T05:30:00Z','twse_mis');
  assert.match(r.tooltip,/13:30.*台北/);
  assert.match(r.text,/2 小時前/);
  assert.doesNotMatch(r.text,/h min/);
});

test('minute ages retain units; unavailable age does not claim a real-time quote', t=>{
  t.mock.method(Date,'now',()=>Date.parse('2026-10-08T05:35:00Z'));
  assert.match(formatPriceTimestamp('2026-10-08T05:30:00Z','twse_mis').text,/5 分鐘前/);
  assert.doesNotMatch(formatPriceTimestamp('2026-10-01T05:30:00Z','twse_mis').text,/即時/);
});
