// One interpretation for the dashboard and holdings. Scores are evidence counts,
// not calibrated probabilities; research-only context never becomes a trade order.
export interface HoldingEvidence {
  symbol: string;
  current_price: number | string | null;
  as_of_ts: string | null;
  price_source: string | null;
  pct_change: number | string | null;
  stop_loss_price: number | string;
  rsi14: number | string | null;
  fund_count_pos: number | null;
  fund_count_total: number | null;
  mom_count_pos: number | null;
  mom_count_total: number | null;
  chip_count_pos: number | null;
  chip_count_total: number | null;
}
export interface EvidenceDates { technical: string | null; fundamental: string | null; chip: string | null }
export interface HoldingDecision {
  state: 'unavailable' | 'review' | 'caution' | 'monitor';
  label: string;
  headline: string;
  reasons: string[];
}
const number = (v: unknown) => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const ymd = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const staleDate = (date: string | null | undefined, maxDays: number, now: number) => {
  const time = date ? Date.parse(`${date}T00:00:00+08:00`) : NaN;
  return !Number.isFinite(time) || time > now || now-time > maxDays*86400_000;
};
export function quoteStatus(at: string | null, source: string | null, now = Date.now()) {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t) || t > now + 60_000) return { reliable: false, label: '報價時間未確認' };
  const c = new Date(now + 8 * 3600_000), m = c.getUTCHours() * 60 + c.getUTCMinutes();
  const market = c.getUTCDay() >= 1 && c.getUTCDay() <= 5 && m >= 9 * 60 && m <= 13 * 60 + 35;
  const daily = !!source && /today|yesterday|daily|finmind|tpex|^twse$/.test(source);
  if (source?.includes('mid')) return { reliable: false, label: '五檔中價估計 · 非成交價' };
  if (!source || !/^(twse_mis|yahoo|twse|tpex|finmind)(_|$)/.test(source)) return { reliable: false, label: '報價來源未確認' };
  if (market && (daily || now - t > 5 * 60_000)) return { reliable: false, label: '盤中報價待更新' };
  // A weekend reference is valid, but arbitrarily old prices are not.
  if (now - t > 5 * 86400_000) return { reliable: false, label: '報價已過期' };
  return { reliable: true, label: market ? '盤中報價' : ymd(t) === ymd(now) ? '收盤後參考價' : '最近交易日參考價' };
}
export function decideHolding(row: HoldingEvidence, signalLevel: string | null, dates: EvidenceDates | null, now = Date.now()): HoldingDecision {
  const price = number(row.current_price), stop = number(row.stop_loss_price), pct = number(row.pct_change);
  const reasons: string[] = [];
  const quality = quoteStatus(row.as_of_ts, row.price_source, now);
  if (price == null || price <= 0 || !quality.reliable) return {
    state: 'unavailable', label: '等待確認', headline: '先確認報價，再評估部位',
    reasons: [price == null || price <= 0 ? '現價未取得' : quality.label, '保留既有停損與觀察價；暫不產生加碼判斷。'],
  };
  if (stop != null && stop > 0 && price <= stop) return {
    state: 'review', label: '優先檢視', headline: '已觸及既定停損參考',
    reasons: [`現價 ${price.toFixed(2)}，既定停損 ${stop.toFixed(2)}。`, '先核對成交價與交易計畫，依原有部位紀律處理。'],
  };
  const dims = [
    { name: '基本面', pos: row.fund_count_pos, total: row.fund_count_total, min: 4 },
    { name: '技術面', pos: row.mom_count_pos, total: row.mom_count_total, min: 2 },
    { name: '籌碼面', pos: row.chip_count_pos, total: row.chip_count_total, min: 2 },
  ];
  const missing = dims.filter(d => d.total == null || d.pos == null || d.total < d.min || d.pos < 0 || d.pos > d.total).map(d => d.name);
  if (missing.length) reasons.push(`${missing.join('、')}可評資料不足，無法確認三面共識。`);
  if (staleDate(dates?.technical, 5, now))
    reasons.push('技術因子的資料日未確認或已過期。');
  if (staleDate(dates?.fundamental, 200, now))
    reasons.push('財報期間未確認或已過期。');
  if (staleDate(dates?.chip, 5, now))
    reasons.push('法人資料日未確認或已過期。');
  if (reasons.length) return { state: 'unavailable', label: '分析受限', headline: '保留部位紀律，等待完整證據', reasons };
  if (pct != null && pct <= -7) reasons.push('持有報酬已低於 −7% 警戒線，優先檢視停損距離。');
  if (signalLevel === 'alert' || signalLevel === 'warning') reasons.push('持股風險訊號出現警告，先確認量價與集中度。');
  if (signalLevel == null) return { state: 'unavailable', label: '分析受限', headline: '持股風險訊號未取得', reasons: ['風險檢查尚未完成，暫不給予安心持有或加碼結論。'] };
  for (const d of dims) if (d.total && (d.pos ?? 0) / d.total < 0.5) reasons.push(`${d.name}僅 ${d.pos}/${d.total} 條件通過，支持偏弱。`);
  const rsi = number(row.rsi14);
  if (rsi != null && rsi > 80) reasons.push(`RSI ${rsi.toFixed(0)} 偏熱，關注動能是否轉弱。`);
  if (reasons.length) return { state: 'caution', label: '留意風險', headline: '先觀察風險變化，暫不加碼', reasons };
  if (pct != null && pct >= 20) return { state: 'monitor', label: '獲利觀察', headline: '已到獲利觀察區，檢視原有出場計畫', reasons: ['觀察價不等同強制停利；持續檢查趨勢與風險。'] };
  return { state: 'monitor', label: '持續觀察', headline: '尚未觸及既定停損，持續追蹤', reasons: ['三面因子有可評資料；依原有交易計畫追蹤，條件通過數不代表勝率。'] };
}
