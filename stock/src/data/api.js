// 統一向後端拿資料；後端內部會做 TWSE / FinMind / Yahoo 調度與 fallback
import { memo as lcMemo } from '../utils/cache.js';

const BASE = '/api';

async function call(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`API ${path} HTTP ${res.status}`);
  const j = await res.json();
  if (!j.ok) throw new Error(`API ${path} : ${j.error}`);
  return j.data;
}

export const api = {
  health: () => call('/health'),
  indices: () => call('/indices'),
  stocks: () => lcMemo('stocks', 86400e3, () => call('/stocks')),
  kline: (code, days = 90) => lcMemo(`kline:${code}:${days}`, 60e3, () => call(`/kline/${code}?days=${days}`)),
  quote: (code) => call(`/quote/${code}`),
  quotesBatch: (codes) => call(`/quotes/batch?codes=${codes.join(',')}`),
  institutional: (code) => lcMemo(`inst:${code}`, 600e3, () => call(`/institutional/${code}`)),
  margin: (code) => lcMemo(`margin:${code}`, 600e3, () => call(`/margin/${code}`)),
  revenue: (code) => lcMemo(`rev:${code}`, 86400e3, () => call(`/revenue/${code}`)),
  financial: (code) => lcMemo(`fin:${code}`, 86400e3, () => call(`/financial/${code}`)),
  shareholding: (code) => lcMemo(`shares:${code}`, 86400e3, () => call(`/shareholding/${code}`)),
  fundamentals: (code) => lcMemo(`fund:${code}`, 3600e3, () => call(`/fundamentals/${code}`)),
  shareholders: (code) => lcMemo(`shrholders:${code}`, 3600e3, () => call(`/shareholders/${code}`)),
  postmarket: () => call('/postmarket/summary'),
  movers: () => call('/movers'),
  news: (category = 'tw_stock', limit = 20, keyword = '') =>
    call(`/news?category=${category}&limit=${limit}${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ''}`),
  intraday: (code, interval = '1m') => lcMemo(`intra:${code}:${interval}`, 30e3, () => call(`/intraday/${code}?interval=${interval}`)),
  ranking: (codes, opts = {}) => {
    const q = new URLSearchParams({
      codes: codes.join(','),
      limit: String(opts.limit || 10),
      ...(opts.minWinRate ? { minWinRate: String(opts.minWinRate) } : {}),
      ...(opts.maxBudget ? { maxBudget: String(opts.maxBudget) } : {}),
    });
    return call(`/ranking?${q}`);
  },
};
