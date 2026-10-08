import test from 'node:test';
import assert from 'node:assert/strict';
import {decideHolding,quoteStatus} from '../lib/holding-decision.ts';
const now=Date.parse('2026-10-08T02:00:00Z');
const dates={technical:'2026-10-07',fundamental:'2026-06-30',chip:'2026-10-07'};
const row={symbol:'TEST',current_price:110,as_of_ts:'2026-10-08T01:59:00Z',price_source:'twse_mis',pct_change:10,stop_loss_price:90,rsi14:65,fund_count_pos:5,fund_count_total:6,mom_count_pos:4,mom_count_total:5,chip_count_pos:3,chip_count_total:4};
test('fresh complete evidence monitors; a warning overrides reassuring factor scores',()=> {
  assert.equal(decideHolding(row,'healthy',dates,now).state,'monitor');
  assert.equal(decideHolding(row,'warning',dates,now).state,'caution');
  assert.equal(decideHolding(row,null,dates,now).state,'unavailable');
});
test('stale, future, unknown-source and indicative prices never become a confident stop or hold',()=> {
  for(const change of [{as_of_ts:'2026-10-08T01:00:00Z'},{as_of_ts:'2026-10-09T01:00:00Z'},{price_source:'twse_mis_mid'},{price_source:null},{price_source:'unknown'},{current_price:NaN}])
    assert.equal(decideHolding({...row,...change,current_price:change.current_price??80},'healthy',dates,now).state,'unavailable');
});
test('known-price stop is prioritised even when fundamentals are missing; profits are observation levels',()=> {
  assert.equal(decideHolding({...row,current_price:89,fund_count_total:0},null,null,now).state,'review');
  const d=decideHolding({...row,pct_change:45},'healthy',dates,now);
  assert.equal(d.label,'獲利觀察');
  assert.doesNotMatch(d.headline,/強制|整張出/);
});
test('partial, stale and malformed factor evidence is visibly unavailable',()=> {
  for(const change of [{chip_count_total:0},{fund_count_total:1},{fund_count_pos:7},{mom_count_pos:null}])
    assert.equal(decideHolding({...row,...change},'healthy',dates,now).state,'unavailable');
  for(const change of [{technical:'invalid'},{fundamental:'2024-01-01'},{chip:'2026-09-20'},{technical:'2026-10-09'}])
    assert.equal(decideHolding(row,'healthy',{...dates,...change},now).state,'unavailable');
});
test('weekend/after-close age is a reference, not a false intraday pipeline failure',()=> {
  assert.equal(quoteStatus('2026-10-08T05:30:00Z','twse_mis',Date.parse('2026-10-08T06:30:00Z')).label,'收盤後參考價');
  assert.equal(quoteStatus('2026-10-09T05:30:00Z','twse_mis',Date.parse('2026-10-11T06:30:00Z')).reliable,true);
  assert.equal(quoteStatus('2026-10-01T05:30:00Z','twse_mis',now).reliable,false);
});
test('weak chip evidence blocks a reassuring holding headline and averaging-down suggestion',()=> {
  const d=decideHolding({...row,chip_count_pos:1,pct_change:-5},'healthy',dates,now);
  assert.equal(d.state,'caution');
  assert.match(d.reasons.join(' '),/籌碼面/);
  assert.doesNotMatch(d.headline,/攤平|可加/);
});
