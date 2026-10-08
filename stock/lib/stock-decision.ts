import 'server-only';
import {unstable_cache} from 'next/cache';
import {createClient} from './supabase/server';
import {holdingDates} from './holding-analysis';
import {decideHolding,type HoldingEvidence} from './holding-decision';
export const stockDecisionContext=unstable_cache(async(symbol:string)=>{
  const sb=createClient();
  const [held,plan,status,fund,official,batch,signal,dates]=await Promise.all([
    sb.from('v_holdings_advice').select('*').eq('symbol',symbol).maybeSingle(),
    sb.from('trade_plans').select('entry_min,entry_max,stop_price,valid_until,entry_reason,exit_rule,status,signal_date').eq('symbol',symbol).in('status',['watching','entered']).order('created_at',{ascending:false}).limit(1).maybeSingle(),
    sb.from('collection_status').select('*').eq('symbol',symbol).eq('dataset','fundamentals').maybeSingle(),
    sb.from('stock_fundamentals_quarterly').select('period_end,source,fetched_at,published_at').eq('symbol',symbol).order('period_end',{ascending:false}).limit(1).maybeSingle(),
    sb.from('official_financial_snapshots').select('period_label,source,observed_at').eq('symbol',symbol).order('observed_at',{ascending:false}).limit(1).maybeSingle(),
    sb.from('r2p_forward_batches').select('signal_date,frozen_at,evidence,strategy_version').eq('strategy_version','R2p-forward-v1').order('signal_date',{ascending:false}).limit(1).maybeSingle(),
    sb.from('v_holdings_signals').select('signal_level').eq('symbol',symbol).maybeSingle(),
    holdingDates([symbol]),
  ]);
  if([held,plan,status,fund,official,batch,signal].some(r=>r.error)) throw new Error('決策依據讀取失敗');
  const frozen=(batch.data?.evidence as {symbol:string;stop:number;selection:Record<string,unknown>}[]|undefined)?.find(s=>s.symbol===symbol);
  return {held:held.data,plan:plan.data,status:status.data,fund:fund.data,official:official.data,
    frozen:frozen?{...frozen,date:batch.data!.signal_date,at:batch.data!.frozen_at,version:batch.data!.strategy_version}:null,
    dates:dates[symbol],decision:held.data?decideHolding(held.data as HoldingEvidence,signal.data?.signal_level??null,dates[symbol]??null):null};
},['stock-decision:v1'],{revalidate:60});
