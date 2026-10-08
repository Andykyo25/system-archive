import 'server-only';
import { unstable_cache } from 'next/cache';
import { createClient } from './supabase/server';
import { readAll } from './db';
import type { EvidenceDates } from './holding-decision';

// Dates change on the collection cadence. Cache by symbols, never cache a failed read.
export const holdingDates = unstable_cache(async (symbols: string[]): Promise<Record<string, EvidenceDates>> => {
  if (!symbols.length) return {};
  const sb = createClient();
  const since = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const [rank, fund, chip, etfs] = await Promise.all([
    sb.from('v_stock_rank').select('symbol,latest_date').in('symbol', symbols),
    readAll<{symbol: string; period_end: string}>((from,to) => sb.from('stock_fundamentals_quarterly').select('symbol,period_end').in('symbol', symbols).order('period_end', {ascending:false}).order('symbol').range(from,to)),
    readAll<{symbol: string; trade_date: string}>((from,to) => sb.from('stock_institutional').select('symbol,trade_date').in('symbol', symbols).gte('trade_date',since).order('trade_date', {ascending:false}).order('symbol').range(from,to)),
    sb.from('etf_metadata').select('symbol').in('symbol',symbols),
  ]);
  const error = [rank,fund,chip,etfs].find(r => r.error)?.error;
  if (error) throw new Error('分析資料時間讀取失敗');
  const result: Record<string, EvidenceDates> = {};
  for (const symbol of symbols) result[symbol] = {
    technical: rank.data?.find(r=>r.symbol===symbol)?.latest_date ?? null,
    fundamental: fund.data?.find(r=>r.symbol===symbol)?.period_end ?? null,
    chip: chip.data?.find(r=>r.symbol===symbol)?.trade_date ?? null,
    assetType:etfs.data?.some(r=>r.symbol===symbol)||/^00/.test(symbol)?'etf':'stock',
  };
  return result;
}, ['holding-evidence-dates:v2'], {revalidate:300});
