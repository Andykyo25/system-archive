import Link from 'next/link';
import {createClient} from '@/lib/supabase/server';
export async function TodayChanges(){
  const sb=createClient();
  const date=new Date(new Date().getTime()+8*3600_000).toISOString().slice(0,10);
  const [events,log]=await Promise.all([
    sb.from('holding_risk_events').select('id,symbol,reason,created_at,notified').gte('created_at',date+'T00:00:00+08:00').order('id',{ascending:false}).limit(6),
    sb.from('fetch_log').select('success,finished_at,error').eq('source','holding_risks').order('started_at',{ascending:false}).limit(1).maybeSingle(),
  ]);
  const error=events.error||log.error;
  return <section className="surface-card rounded-2xl p-5" aria-label="今日變化">
    <div className="flex flex-wrap justify-between gap-2"><h2 className="text-lg font-semibold">今日變化</h2><Link href="/track" className="text-sm text-sky-300">前向執行 →</Link></div>
    {error?<p role="alert" className="mt-3 text-sm text-amber-200">後端監控紀錄讀取失敗，暫無法確認變化。</p>:<><p className="mt-2 text-xs text-slate-400">盤中每 10 分鐘檢查，關閉網頁後仍由後端執行；盤後可重試待送通知。最近執行：{log.data?.finished_at?new Date(log.data.finished_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'尚無執行紀錄'}</p>
    {log.data?.success===false&&<p role="alert" className="mt-2 text-sm text-amber-200">監控執行異常：{log.data.error}</p>}
    {!events.data?.length?<p className="mt-4 text-sm text-slate-300">今天尚無已記錄的持股風險變化。</p>:<ul className="mt-4 space-y-3">{events.data.map(e=><li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-3 text-sm"><Link href={`/stocks/${e.symbol}`} className="text-slate-200">{e.symbol} · {e.reason}</Link><span className="text-xs text-slate-400">{new Date(e.created_at).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})} · {e.notified?'通知已送達':'通知待送'}</span></li>)}</ul>}</>}
    <p className="mt-3 text-xs text-slate-500">停損距離 3% 警戒／5% 解除；股票市值占比 40% 警戒／35% 解除。財報檢查新一期負 EPS 或負營業現金流，並非完整重大訊息監控。</p>
  </section>;
}
