import Link from 'next/link';
import type {stockDecisionContext} from '@/lib/stock-decision';
import {collectionNumber} from '@/lib/collection';
type Context=Awaited<ReturnType<typeof stockDecisionContext>>;
const factors=[
  ['fund_eps_grow','EPS 成長'],['fund_roe_high','ROE 門檻'],['fund_fcf_pos','自由現金流'],
  ['fund_rev_yoy','月營收成長'],['mom_ma_golden','均線排列'],['mom_above_ma200','站上長期均線'],
  ['mom_rsi_strong','RSI 動能'],['chip_foreign_3d_buy','法人連買'],['chip_margin_drop','融資下降'],
  ['chip_lending_drop','借券下降'],['chip_share_concentrate','外資持股'],
];
export function StockDecisionBrief({context,rank,isEtf,error,priceDate}:{
  context:Context|null;rank:Record<string,unknown>|null;isEtf:boolean;error:string|null;priceDate:string|null;
}){
  const support=factors.filter(([key])=>collectionNumber(rank?.[key])===1).map(([,label])=>label);
  const oppose=factors.filter(([key])=>collectionNumber(rank?.[key])===0).map(([,label])=>label);
  const frozen=context?.frozen;
  const active=frozen&&frozen.date===priceDate;
  const heldStop=collectionNumber(context?.held?.stop_loss_price);
  const title=error?'依據讀取失敗，暫不產生綜合結論':context?.decision?.headline??(active?'符合凍結的 R2p 候選條件，等待交易前確認':isEtf?'ETF 依配置、價格趨勢與部位風險獨立評估':'先核對三面證據與資料時效');
  return <section id="decision" className="section-anchor surface-card rounded-3xl p-5 sm:p-6" aria-label="個股決策摘要">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow">決策依據</p><h2 className="mt-2 text-xl font-semibold text-slate-100">{title}</h2></div><Link href="/scan" className="text-sm text-sky-300">選股條件 →</Link></div>
    {error&&<p role="alert" className="mt-3 text-sm text-amber-200">{error}；保留可讀資料，暫無法確認整體判讀。</p>}
    <p className="mt-3 text-sm leading-relaxed text-slate-400">{active?`上榜原因：分數 ≥80、距 60 日高點不到 5%、上方套牢量 ≤10%、0050 在 MA60 上方；${frozen.version} 於 ${frozen.date} 凍結。`:frozen?`上次 R2p 凍結日 ${frozen.date}，與目前日線不同；不能當作今日進場訊號。`:'尚無最新 R2p 凍結入選紀錄；因子排名與 R2p 使用不同條件。'}</p>
    <div className="mt-5 grid gap-4 md:grid-cols-3">
      <Evidence title="支持證據" items={isEtf?['ETF 不套用個股 EPS／ROE 財務因子']:support} empty="尚無已確認的支持條件" />
      <Evidence title="反對／未通過" items={isEtf?[]:oppose} empty={isEtf?'另看成分股、淨值折溢價與追蹤誤差':'未取得反對條件；不等於全部通過'} />
      <div className="rounded-2xl border border-line bg-black/10 p-4"><h3 className="text-sm font-medium">資料限制</h3><ul className="mt-3 space-y-2 text-xs leading-relaxed text-slate-400">
        <li>日線 {context?.dates?.technical??priceDate??'未確認'} · 法人 {context?.dates?.chip??'未確認'}</li>
        <li>{isEtf?'ETF 無個股季報要求':`財報期間 ${context?.fund?.period_end??'未取得'} · ${context?.fund?.source??'舊資料來源未標示'}`}</li>
        {!isEtf&&<li>公告時間 {context?.fund?.published_at??'未知，不能當作歷史當時已知'}</li>}
        {context?.status&&context.status.status!=='ok'&&<li className="text-amber-200">{context.status.reason??'來源可評資料不足'}</li>}
        {context?.official&&<li>官方補充 {context.official.period_label}；累計口徑尚未混入季報評分。</li>}
        <li>缺值保持未知；條件通過數不代表勝率。淨值與重大訊息尚未完整納入。</li>
      </ul></div>
    </div>
    <div className="mt-5 border-t border-line pt-4"><h3 className="text-sm font-medium">何時失效／需要重新檢視</h3><p className="mt-2 text-sm leading-relaxed text-slate-400">{context?.held?`${heldStop!=null&&heldStop>0?`觸及部位既定停損 ${heldStop.toFixed(2)}`:'部位停損尚未確認'}；報價過期或三面缺料時，停止給予確定部位結論。`:active?`下一交易日曾觸及凍結停損 ${frozen.stop?.toFixed(2)??'未確認'}，前向模擬跳過進場；價格跳空、資料更新及個人風險預算仍需重新檢查。`:'條件或資料日更新後重新評估；目前沒有足夠依據指定進場。'}</p>
    {context?.plan&&<p className="mt-2 text-xs text-slate-400">已有計畫：進場 {Number(context.plan.entry_min).toFixed(2)}–{Number(context.plan.entry_max).toFixed(2)} · 計畫停損 {Number(context.plan.stop_price).toFixed(2)} · 有效至 {context.plan.valid_until} · {context.plan.exit_rule}</p>}
    </div>
  </section>;
}
function Evidence({title,items,empty}:{title:string;items:string[];empty:string}){
  return <div className="rounded-2xl border border-line bg-black/10 p-4"><h3 className="text-sm font-medium">{title}</h3>{items.length?<ul className="mt-3 space-y-2 text-sm text-slate-300">{items.map(s=><li key={s}>{s}</li>)}</ul>:<p className="mt-3 text-xs leading-relaxed text-slate-400">{empty}</p>}</div>;
}
