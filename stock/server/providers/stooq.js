// Stooq.com — 國際指數 / ETF 免費 CSV API
// 文件：https://stooq.com/q/d/?s=...
// 不需 token、無 rate limit、CDN 全球都可達（補 Yahoo 429 海外 IP 限制）

const BASE = 'https://stooq.com/q/l/';

async function fetchCsv(symbol) {
  const url = `${BASE}?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 TWSE-WarRoom/1.0', Accept: 'text/csv' },
  });
  if (!res.ok) throw new Error(`stooq HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  const headers = lines[0].split(',').map((h) => h.trim());
  const cells = lines[1].split(',').map((c) => c.trim());
  const row = Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
  if (row.Close === 'N/D' || !row.Close) return null;
  return {
    symbol: row.Symbol,
    date: row.Date,
    time: row.Time,
    open: +row.Open || null,
    high: +row.High || null,
    low: +row.Low || null,
    close: +row.Close || null,
    volume: +row.Volume || null,
  };
}

// 拉兩天 daily history 拿前一日 close（用於計算正確的「跟昨收」漲跌）
async function fetchPrevClose(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  try {
    const res = await fetch(url, { headers: { Accept: 'text/csv' } });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 3) return null;
    // 倒數第二行是前一日 K 線
    const cells = lines[lines.length - 2].split(',');
    return +cells[4]; // Close 欄位
  } catch { return null; }
}

// 國際指數：^SOX 拿不到（用 SOXX ETF 代替），^IXIC 拿不到（用 ^NDX 代替）
const SYMBOL_MAP = {
  '^SOX':  'soxx.us',  // iShares Semiconductor ETF（費半代理）
  '^IXIC': '^ndx',     // Nasdaq 100
  '^GSPC': '^spx',     // S&P 500
  '^DJI':  '^dji',     // Dow Jones
  '^TWII': '^twi',     // 嘗試（fallback 用）
};

const DISPLAY_NAME = {
  '^SOX':  'SOXX (費半 ETF)',
  '^IXIC': 'Nasdaq 100',
  '^GSPC': 'S&P 500',
  '^DJI':  'Dow Jones',
};

// prevClose cache（一天有效，避免每次 polling 都拉 daily history）
const prevCloseCache = new Map();

async function getPrevCloseCached(stooqSym) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${stooqSym}:${today}`;
  if (prevCloseCache.has(key)) return prevCloseCache.get(key);
  const v = await fetchPrevClose(stooqSym);
  prevCloseCache.set(key, v);
  // 過期清理
  if (prevCloseCache.size > 50) {
    const oldKeys = [...prevCloseCache.keys()].filter((k) => !k.endsWith(today));
    oldKeys.forEach((k) => prevCloseCache.delete(k));
  }
  return v;
}

export async function quotes(symbols) {
  if (!Array.isArray(symbols) || !symbols.length) return [];
  const out = await Promise.all(symbols.map(async (sym) => {
    const stooqSym = SYMBOL_MAP[sym] || sym.toLowerCase();
    try {
      const [r, prevClose] = await Promise.all([
        fetchCsv(stooqSym),
        getPrevCloseCached(stooqSym),
      ]);
      if (!r || r.close == null) return { symbol: sym, error: 'no data' };
      return {
        symbol: sym,
        displayName: DISPLAY_NAME[sym] || sym,
        price: r.close,
        prevClose: prevClose ?? r.open,  // fallback 用 open（日內漲跌）
        dayHigh: r.high,
        dayLow: r.low,
        volume: r.volume,
        time: r.time && r.date ? Math.floor(new Date(`${r.date}T${r.time}Z`).getTime() / 1000) : null,
        source: 'stooq',
      };
    } catch (e) {
      return { symbol: sym, error: e.message };
    }
  }));
  return out;
}
