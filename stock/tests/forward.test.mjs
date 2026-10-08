import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialState,forwardSession,POLICY} from '../supabase/functions/run-r2p-forward/engine.ts';
const bar=(symbol,date,over={})=>({symbol,date,open:50,high:52,low:48,close:50,volume:100000,factor:1,...over});
const d0='2026-10-08',d1='2026-10-09',d2='2026-10-12';
const sig={date:d0,symbol:'2330',rank:1,stop:45,close:50,factor:1};
const base=()=>forwardSession(initialState(),d0,null,[],[bar('0050',d0)]);
const entered=()=>forwardSession(base(),d1,d0,[sig],[bar('0050',d1),bar('2330',d1)]);
test('forward: prospective T+1 close, lot/cash constraints, fees, no entry-day take profit and no mutation',()=>{
  const old=base(),snapshot=structuredClone(old);
  const next=forwardSession(old,d1,d0,[sig],[bar('0050',d1),bar('2330',d1,{high:60})]);
  assert.deepEqual(old,snapshot);assert.equal(next.positions.length,1);assert.equal(next.trades.length,0);
  assert.equal(next.positions[0].qty,1000);assert.equal(next.positions[0].entry,50.05);
  assert.ok(next.cash<950000);assert.ok(next.equity<POLICY.capital);
  assert.throws(()=>forwardSession(next,d1,d0,[sig],[]),/committed/);
});
test('forward: day-1 stop blocks entry, missing bars pause rather than synthesize fills',()=>{
  const skipped=forwardSession(base(),d1,d0,[sig],[bar('0050',d1),bar('2330',d1,{low:44})]);
  assert.equal(skipped.trades[0].reason,'entry_day_stop');assert.equal(skipped.cash,POLICY.capital);
  assert.throws(()=>forwardSession(entered(),d2,d1,[],[bar('0050',d2)]),/missing OHLC/);
});
test('forward: same bar stop/TP gives stop precedence; gaps fill open with adverse slippage',()=>{
  const out=forwardSession(entered(),d2,d1,[],[bar('0050',d2),bar('2330',d2,{open:44,low:43,high:60,close:48})]);
  assert.equal(out.trades[0].reason,'gap_stop');assert.equal(out.trades[0].exit,44*.999);
  assert.ok(out.trades[0].net<0);assert.ok(out.maxDrawdown<0);
  assert.equal(out.equity,out.cash);
});
test('forward: locked limit down defers exit, suspended bars are not sellable; corporate action pauses',()=>{
  const locked=forwardSession(entered(),d2,d1,[],[bar('0050',d2),bar('2330',d2,{open:45,low:45,high:45,close:45})]);
  assert.equal(locked.positions[0].exitPending,true);assert.equal(locked.trades.length,0);
  const exit=forwardSession(locked,'2026-10-13',d2,[],[bar('0050','2026-10-13'),bar('2330','2026-10-13',{open:44,low:43,close:44})]);
  assert.equal(exit.trades[0].reason,'deferred_stop');
  assert.throws(()=>forwardSession(entered(),d2,d1,[],[bar('0050',d2),bar('2330',d2,{factor:2})]),/reconciliation/);
});
test('forward: time exit occurs on 20th held session, and expensive stocks cannot consume imaginary cash',()=>{
  let s=entered();
  for(let i=1;i<=19;i++){const date='2026-11-'+String(i).padStart(2,'0');s=forwardSession(s,date,s.lastDate,[],[bar('0050',date),bar('2330',date)]);}
  assert.equal(s.trades[0].reason,'time_exit');assert.equal(s.positions.length,0);
  const high=forwardSession(base(),d1,d0,[{...sig,stop:400}],[bar('0050',d1),bar('2330',d1,{open:500,low:490,high:510,close:500})]);
  assert.equal(high.trades[0].reason,'insufficient_cash_or_lot');assert.equal(high.cash,POLICY.capital);
});
