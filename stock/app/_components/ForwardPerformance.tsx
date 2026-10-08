import {createClient} from '@/lib/supabase/server';
import {fmtMoney,fmtPct} from './Format';
export async function ForwardPerformance(){
  const sb=createClient();
  const [state,last,log,batch]=await Promise.all([
    sb.from('r2p_forward_state').select('payload,updated_at').eq('strategy_version','R2p-forward-v1').maybeSingle(),
    sb.from('r2p_forward_daily').select('*').eq('strategy_version','R2p-forward-v1').order('trade_date',{ascending:false}).limit(1).maybeSingle(),
    sb.from('fetch_log').select('success,error,finished_at').eq('source','r2p_forward').order('started_at',{ascending:false}).limit(1).maybeSingle(),
    sb.from('r2p_forward_batches').select('signal_date').eq('strategy_version','R2p-forward-v1').order('signal_date').limit(1).maybeSingle(),
  ]);
  const error=[state,last,log,batch].some(r=>r.error);
  const row=last.data,payload=state.data?.payload;
  const closed=(payload?.trades??[]).filter((t:{net:number|null})=>t.net!=null) as {net:number}[];
  return <section className="surface-card rounded-2xl p-5" aria-label="R2p 前向執行">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">R2p 前向執行</h2><span className="text-xs text-sky-300">模擬帳本 · R2p-forward-v1</span></div>
    <p className="mt-2 text-sm text-slate-400">只記錄上線後凍結的每日訊號，依固定規則模擬成交。實際帳戶損益請看持股頁。</p>
    {error?<p role="alert" className="mt-4 text-sm text-amber-200">前向帳本讀取失敗，暫無法確認績效。</p>:!row?<p className="mt-4 text-sm text-slate-300">{batch.data?'已凍結訊號，等待完成交易日執行。':'等待首個交易日收盤後凍結；不補造過去績效。'}</p>:<div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
      {[['扣成本報酬',fmtPct(100*(Number(row.equity)/1_000_000-1))],['最大回撤',fmtPct(row.max_drawdown)],['0050 同期',fmtPct(row.benchmark_pct)],['已平倉淨勝率',closed.length?`${(100*closed.filter(t=>t.net>0).length/closed.length).toFixed(1)}%`:'尚無平倉']].map(([label,value])=><div key={label}><p className="text-xs text-slate-400">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{value}</p></div>)}
    </div>}
    {row&&<p className="mt-4 text-xs text-slate-400">起始 {batch.data?.signal_date??'未確認'} · 結算 {row.trade_date} · 現金 {fmtMoney(row.cash,0)} · {row.positions} 個模擬部位 · {row.closed} 筆平倉</p>}
    {log.data?.success===false&&<p role="alert" className="mt-3 text-sm text-amber-200">帳本暫停：{log.data.error}。最後成功日期與新行情可能不同。</p>}
    <details className="mt-4 border-t border-line pt-3 text-xs text-slate-400"><summary className="cursor-pointer text-sm">執行規則與限制</summary><p className="mt-3 leading-relaxed">訊號日收盤 − 3 ATR 停損；下一交易日收盤進場，當日曾觸停損則跳過；+10% 停利，最多持有 20 交易日。同日停損優先，跌停鎖住延後賣出。初始模擬資金 100 萬，每檔最多初始資金 10%，最多 10 部位、整張股數。雙邊手續費各 0.1425%、賣出稅 0.3%、雙邊不利滑價各 0.1%；日終估值未扣未成交的賣出費用。缺價或除權息待處理會暫停，成交量不保證可成交，未模擬委託佇列。</p></details>
  </section>;
}
