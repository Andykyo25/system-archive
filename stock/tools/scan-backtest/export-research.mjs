// Regenerate the read-only research snapshot shown next to R2p candidates.
// Run from tools/scan-backtest. No database writes; the model matches r2p.mjs.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {SIG,stats,sim,COST} from './lib.mjs';
const groups=new Map();
for (const s of SIG.filter(s=>s.score>=80&&s.offHi60>-5&&s.supply90<=0.1&&s.e50_ma60>0)) {
  if (!groups.has(s.d)) groups.set(s.d,[]);
  groups.get(s.d).push(s);
}
const picks=[...groups.values()].flatMap(xs=>xs.sort((a,b)=>b.score-a.score||b.dayPct-a.dayPct).slice(0,3));
const trades=picks.filter(s=>s.path?.length>=20&&s.l1!=null&&1+s.l1/100>1-3*s.atrPct/100);
const ret=s=>sim(s,{H:20,tp:10,stop:1-3*s.atrPct/100});
const net=trades.map(s=>ret(s)-COST);
const perDay=new Map();
for (const s of trades) { if(!perDay.has(s.d)) perDay.set(s.d,[]); perDay.get(s.d).push(ret(s)-COST); }
const dayNet=[...perDay.values()].map(xs=>xs.reduce((a,b)=>a+b,0)/xs.length);
const report={
  strategy:'R2p-20260929',checkedOn:'2026-10-08',
  inputSha256:crypto.createHash('sha256').update(fs.readFileSync('signals.json')).digest('hex'),
  from:trades.map(s=>s.d).sort()[0],to:trades.map(s=>s.d).sort().at(-1),
  costPct:COST,trades:trades.length,days:perDay.size,
  netWinPct:stats(trades,ret).netWin,meanNetPct:stats(trades,ret).mean,
  dayWeightedMeanNetPct:dayNet.reduce((a,b)=>a+b,0)/dayNet.length,
  worstNetPct:Math.min(...net),
  years:[...new Set(trades.map(s=>s.d.slice(0,4)))].sort().map(year=>({year,...stats(trades.filter(s=>s.d.startsWith(year)),ret)})),
  limits:['翌日收盤進場、訊號收盤 − 3×ATR 停損、+10% 停利、最長 20 交易日；與手動成交可能不同。','扣固定成本 0.585%；未計滑價、流動性衝擊與同時持倉資金限制。','產業分類非當時版本；2025–2026 研究驗證段已用於策略開發，不等同未看過的獨立測試。','每筆交易統計不等同帳戶報酬；新增條件需要獨立前向驗證。'],
};
fs.writeFileSync('../../lib/r2p-research.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({trades:report.trades,from:report.from,to:report.to,meanNetPct:report.meanNetPct,worstNetPct:report.worstNetPct}));
