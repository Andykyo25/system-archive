// Read-only audit of the configured database. Never prints credentials or account balances.
import { writeFile } from 'node:fs/promises';
process.loadEnvFile('.env.local');
const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!base || !key) throw new Error('Missing configured database credentials');
const requests = {
  health: 'v_data_health?select=category,key,label,level,metric_text,detail',
  prices: 'price_daily?select=trade_date&order=trade_date.desc&limit=1',
  quotes: 'price_intraday_cache?select=quoted_at,source&order=quoted_at.desc&limit=1',
  factors: 'v_stock_rank?select=symbol,fund_count_total,mom_count_total,chip_count_total&limit=1000',
  verdict: 'v_scan_verdict?select=symbol,trade_date,score_total,off_hi60,supply_share,market_ma60_pct',
  live: 'v_verdict_live?select=symbol,state,reason,quoted_at',
};
const results = await Promise.all(Object.entries(requests).map(async ([name,path]) => {
  const start=Date.now();
  try {
    const r=await fetch(`${base}/rest/v1/${path}`, {headers:{apikey:key,Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000)});
    const data=await r.json();
    const summary=name==='factors' && Array.isArray(data) ? {
      sample:data.length, capped:data.length===1000,
      withFund:data.filter(x=>x.fund_count_total>0).length,
      withTechnical:data.filter(x=>x.mom_count_total>0).length,
      withChip:data.filter(x=>x.chip_count_total>0).length,
      allThree:data.filter(x=>x.fund_count_total>0&&x.mom_count_total>0&&x.chip_count_total>0).length,
    } : data;
    return [name,{status:r.status,ms:Date.now()-start,data:summary}];
  } catch { return [name,{error:'Network request failed',ms:Date.now()-start}]; }
}));
const report={checkedAt:new Date().toISOString(),results:Object.fromEntries(results)};
if (process.argv.includes('--save')) await writeFile('tasks/project-audit-data.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
