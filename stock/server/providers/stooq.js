// Stooq.com — 國際指數 / ETF 免費 CSV API
// 文件：https://stooq.com/q/d/?s=...
// 不需 token、無 rate limit、CDN 全球都可達（補 Yahoo 429 海外 IP 限制）

const BASE = 'https://stooq.com/q/l/';

async function fetchCsv(symbol) {
  // f=snd2t2ohlcvp 含「Prev」前一日收盤欄位，免拉 daily history
  const url = `${BASE}?s=${encodeURIComponent(symbol)}&f=snd2t2ohlcvp&h&e=csv`;
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
    name: row.Name,
    date: row.Date,
    time: row.Time,
    open: +row.Open || null,
    high: +row.High || null,
    low: +row.Low || null,
    close: +row.Close || null,
    volume: +row.Volume || null,
    prevClose: +row.Prev || null,
  };
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

export async function quotes(symbols) {
  if (!Array.isArray(symbols) || !symbols.length) return [];
  const out = await Promise.all(symbols.map(async (sym) => {
    const stooqSym = SYMBOL_MAP[sym] || sym.toLowerCase();
    try {
      const r = await fetchCsv(stooqSym);
      if (!r || r.close == null) return { symbol: sym, error: 'no data' };
      return {
        symbol: sym,
        displayName: DISPLAY_NAME[sym] || sym,
        price: r.close,
        prevClose: r.prevClose ?? r.open,  // fallback 用 open（日內漲跌）
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
