import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateRisk } from '../lib/plan-risk.ts';
const context={cash:50000,equity:100000,risk_pct:0.01,fee_rate:0.001425,tax_rate:0.003,price_date:'2026-09-04',calculated_at:'2026-09-06T00:00:00Z',coverage_ok:true,positions:[{symbol:'TEST',industry:'半導體業',market_value:18000},{symbol:'OTHER',industry:'半導體業',market_value:20000}]};
const input={symbol:'TEST',industry:'半導體業',entry:100,stop:95,positionPct:30,industryPct:50,slippagePct:0.1};
test('risk estimate includes both-side fees/tax/slippage and respects all caps',()=>{
  const r=estimateRisk(context,input,'2026-09-06');
  assert.ok(r.riskPerShare>5);assert.ok(r.cashRequired<=context.cash);assert.ok(r.estimatedLoss<=1000);
  assert.equal(r.shares,119);assert.deepEqual(r.limitingFactors,['單股集中度','產業集中度']);
});
test('negative cash sizes to zero and stays visible; unusable valuation still refuses',()=>{
  // Over-invested (or a rounding residue) is a real account state. Refusing to
  // estimate hides it behind an error; 0 shares reports it.
  const r=estimateRisk({...context,cash:-1},input,'2026-09-06');
  assert.equal(r.shares,0);
  assert.deepEqual(r.limitingFactors,['可用現金']);
  assert.equal(r.inputs.cash,-1);
  assert.throws(()=>estimateRisk({...context,coverage_ok:false},input,'2026-09-06'));
  assert.throws(()=>estimateRisk({...context,price_date:'2026-08-01'},input,'2026-09-06'));
  assert.throws(()=>estimateRisk({...context,equity:0},input,'2026-09-06'));
});
test('concentration caps are optional; risk budget and cash alone still size a trade',()=>{
  const noCaps={symbol:'TEST',industry:'半導體業',entry:100,stop:95,slippagePct:0.1};
  const r=estimateRisk(context,noCaps,'2026-09-06');
  assert.deepEqual(r.caps.map(c=>c.label),['單筆風險預算','可用現金']);
  assert.equal(r.positionPct,null);
  assert.equal(r.industryPct,null);
  assert.equal(r.shares,173);
  assert.deepEqual(r.limitingFactors,['單筆風險預算']);
  assert.ok(r.estimatedLoss<=r.riskBudget);
  // Supplying only one cap still applies just that one.
  assert.equal(estimateRisk(context,{...noCaps,industryPct:30},'2026-09-06').shares,0);
  assert.throws(()=>estimateRisk(context,{...noCaps,positionPct:0},'2026-09-06'),/集中度/);
});
test('existing concentration and zero cash each yield zero capacity',()=>{
  assert.equal(estimateRisk({...context,cash:0},input,'2026-09-06').shares,0);
  assert.equal(estimateRisk(context,{...input,industryPct:30},'2026-09-06').shares,0);
});
