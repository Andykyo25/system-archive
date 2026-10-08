import Link from 'next/link';
import { ArrowUpRight, ShieldAlert } from 'lucide-react';
import { decideHolding, quoteStatus, type EvidenceDates } from '@/lib/holding-decision';
import type { HoldingAdviceRow, SignalRow } from '@/app/holdings/HoldingsAdvice';
import { fmtMoney, fmtPct, pctColor } from './Format';

const tone = {
  unavailable: 'border-slate-400/25 bg-slate-400/10 text-slate-200',
  review: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  caution: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  monitor: 'border-sky-400/25 bg-sky-400/10 text-sky-200',
};
export function HoldingDecisionPanel({rows,signalsMap,dates,loadError}: {
  rows: HoldingAdviceRow[]; signalsMap: Record<string,SignalRow>;
  dates: Record<string,EvidenceDates>; loadError?: string | null;
}) {
  const now=new Date().getTime();
  return <section className="space-y-4" aria-label="持股綜合分析">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-lg font-semibold">持股綜合分析</h2>
      <span className="text-xs text-slate-400">先看風險，再看三面依據</span>
    </div>
    {loadError ? <p role="alert" className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 text-sm text-amber-200">{loadError}。暫無法提供完整持股判斷。</p> : !rows.length ? <p className="text-sm text-slate-400">目前無持股，新增交易後會在此分析。</p> : null}
    <div className={`grid gap-4 ${rows.length > 1 ? 'xl:grid-cols-2' : ''}`}>
      {rows.map(row=> {
        const signal=signalsMap[row.symbol], datesRow=dates[row.symbol];
        const decision=decideHolding(row,loadError?null:signal?.signal_level??null,loadError?null:datesRow??null,now);
        const time=row.as_of_ts ? new Date(row.as_of_ts).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '未取得';
        const dims=[
          {name:'基本面',pos:row.fund_count_pos,total:row.fund_count_total,date:datesRow?.fundamental,label:'財報期間'},
          {name:'技術面',pos:row.mom_count_pos,total:row.mom_count_total,date:datesRow?.technical,label:'日線'},
          {name:'籌碼面',pos:row.chip_count_pos,total:row.chip_count_total,date:datesRow?.chip,label:'法人'},
        ];
        return <article key={row.symbol} className="rounded-2xl border border-line bg-surface-1 p-5" data-testid={`holding-decision-${row.symbol}`}>
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <Link href={`/stocks/${row.symbol}`} className="inline-flex items-center gap-2 text-lg font-semibold text-slate-100 hover:text-sky-300">{row.symbol}<ArrowUpRight size={16} aria-hidden/></Link>
              <p className="mt-1 text-xs text-slate-400">{row.net_qty.toLocaleString()} 股 · 均價 {fmtMoney(row.avg_cost,2)}</p>
            </div>
            <div className="text-right">
              <p className="text-xl font-medium tabular-nums">{fmtMoney(row.current_price,2)}</p>
              <p className={`text-sm ${pctColor(row.pct_change)}`}>持有 {fmtPct(row.pct_change)}</p>
            </div>
          </header>
          <div className={`mt-4 rounded-xl border p-3 ${tone[decision.state]}`}>
            <p className="flex items-center gap-2 text-xs"><ShieldAlert size={14} aria-hidden/>{decision.label}</p>
            <h3 className="mt-1 text-sm font-medium">{decision.headline}</h3>
            <ul className="mt-2 space-y-1 text-xs leading-relaxed">{decision.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-3">
            {dims.map(d=><div key={d.name} className="min-w-0">
              <dt className="text-xs text-slate-400">{d.name}</dt>
              <dd className="mt-1 text-sm tabular-nums">{d.total && d.pos!=null ? `${d.pos}/${d.total} 通過` : '資料不足'}</dd>
              <dd className="mt-1 break-words text-xs text-slate-400">{d.label} {d.date??'未確認'}</dd>
            </div>)}
          </dl>
          <p className="mt-3 text-xs text-slate-400">條件通過數 ≠ 勝率 · 法人日期不代表全部籌碼來源同日</p>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-3 text-sm">
            <span>既定停損 <span className="tabular-nums">{fmtMoney(row.stop_loss_price,2)}</span></span>
            <span>觀察價 <span className="tabular-nums">{fmtMoney(row.obs1_price,2)}</span></span>
            <Link href={`/intraday?symbol=${row.symbol}`} className="text-sky-300">盤中細看 →</Link>
          </div>
          <footer className="mt-3 text-xs leading-relaxed text-slate-400">{quoteStatus(row.as_of_ts,row.price_source,now).label} · {time} 台北 · {row.price_source??'來源未確認'}</footer>
          {signal?.signals?.length ? <details className="mt-3 border-t border-line pt-3">
            <summary className="cursor-pointer text-sm text-slate-300">風險訊號明細</summary>
            <ul className="mt-3 grid gap-2 text-xs sm:grid-cols-2">{signal.signals.map(s=><li key={s.key}><span className="text-slate-400">{s.label}：</span>{s.value}{s.level==='orange'||s.level==='red'?' · 注意':''}</li>)}</ul>
          </details>:null}
        </article>;
      })}
    </div>
  </section>;
}
