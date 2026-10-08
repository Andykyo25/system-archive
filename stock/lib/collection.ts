export const collectionNumber = (value: unknown): number | null => {
  if (value == null || typeof value === 'boolean' || String(value).trim()==='') return null;
  const n=Number(String(value).replaceAll(',',''));
  return Number.isFinite(n) ? n : null;
};
export interface CollectionTarget {symbol:string;priority:number;is_etf:boolean}
export function collectionOrder(targets:CollectionTarget[], statuses:{symbol:string;observed_at:string;status:string}[],now=Date.now()) {
  const last=new Map(statuses.map(s=>[s.symbol,s]));
  return targets.filter(t=>!t.is_etf && !/^00/.test(t.symbol)).filter(t=>{
    const s=last.get(t.symbol);
    return !s || now-Date.parse(s.observed_at) > (s.status==='ok' ? 7*86400_000 : 6*3600_000);
  }).sort((a,b)=>a.priority-b.priority ||
    (Date.parse(last.get(a.symbol)?.observed_at ?? '')||0)-(Date.parse(last.get(b.symbol)?.observed_at ?? '')||0) ||
    a.symbol.localeCompare(b.symbol));
}
