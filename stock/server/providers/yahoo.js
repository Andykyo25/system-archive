// Yahoo Finance — 國際指數備援（費半 SOX、Nasdaq、SP500）
// 走 query1.finance.yahoo.com，無需 token，但需從後端打避免 CORS。

const BASE = 'https://query1.finance.yahoo.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`yahoo HTTP ${res.status} ${url}`);
  return res.json();
}

// 即時報價（單一或多檔），回傳簡化結構
// Yahoo 沒公開 rate limit，但實測 ~5 qps 會被擋，採 chunk 並發控制
const CHUNK = 6;
const CHUNK_DELAY_MS = 120;

async function fetchOne(sym) {
  try {
    const j = await fetchJson(`${BASE}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`);
    const r = j.chart?.result?.[0];
    if (!r) return null;
    const meta = r.meta || {};
    return {
      symbol: sym,
      price: meta.regularMarketPrice ?? null,
      prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
      dayHigh: meta.regularMarketDayHigh ?? null,
      dayLow: meta.regularMarketDayLow ?? null,
      volume: meta.regularMarketVolume ?? null,
      currency: meta.currency,
      time: meta.regularMarketTime,
      marketState: meta.marketState,
    };
  } catch (e) {
    return { symbol: sym, error: e.message };
  }
}

export async function quotes(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return [];
  const out = [];
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const batch = symbols.slice(i, i + CHUNK);
    const results = await Promise.all(batch.map(fetchOne));
    out.push(...results);
    if (i + CHUNK < symbols.length) {
      await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
    }
  }
  return out;
}

// 歷史 K 線
export async function chart(symbol, range = '3mo', interval = '1d') {
  const j = await fetchJson(`${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`);
  const r = j.chart?.result?.[0];
  if (!r) return [];
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    open: q.open?.[i],
    high: q.high?.[i],
    low: q.low?.[i],
    close: q.close?.[i],
    volume: q.volume?.[i],
  })).filter((d) => d.close != null);
}
