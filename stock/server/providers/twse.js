// 證交所 OpenAPI — 盤後精準資料
// https://openapi.twse.com.tw/
// 注意：部分 endpoint 盤中時段會回 HTML 維護頁，呼叫端需 try/catch 並 fallback。

const BASE = 'https://openapi.twse.com.tw/v1';

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json' },
    redirect: 'manual',
  });
  if (res.status !== 200) throw new Error(`twse ${path} status=${res.status}`);
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!ct.includes('json') && text.trim().startsWith('<')) {
    throw new Error(`twse ${path} returned HTML (likely maintenance / not yet published)`);
  }
  return JSON.parse(text);
}

// 大盤所有指數收盤
export async function indices() {
  return fetchJson('/exchangeReport/MI_INDEX');
}

// 個股單月日線歷史（傳 yyyymm01 格式日期）
// 直接打 www.twse.com.tw 不走 openapi（因為 openapi 沒有此端點）
export async function stockDay(stockNo, yyyymmFirst) {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${yyyymmFirst}&stockNo=${encodeURIComponent(stockNo)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 TWSE-WarRoom/1.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`twse stockDay HTTP ${res.status}`);
  const j = await res.json();
  if (j.stat !== 'OK') throw new Error(`twse stockDay ${j.stat || 'no data'}`);
  return (j.data || []).map((row) => {
    const parts = String(row[0] || '').split('/');
    if (parts.length !== 3) return null;
    const isoDate = `${+parts[0] + 1911}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    const num = (s) => {
      const n = +String(s ?? '0').replace(/,/g, '');
      return Number.isFinite(n) ? n : null;
    };
    return {
      date: isoDate,
      open: num(row[3]),
      high: num(row[4]),
      low: num(row[5]),
      close: num(row[6]),
      // row[1] 為「成交股數」，台股 1 張=1000 股
      volume: Math.round((num(row[1]) || 0) / 1000),
    };
  }).filter((d) => d && Number.isFinite(d.close));
}

// 拉 N 天日線歷史（內部分月撈 + 速率限制）— 給 K 線 fallback 用
export async function stockDayHistory(stockNo, days = 90) {
  const today = new Date();
  const monthsNeeded = Math.ceil(days / 22) + 1;
  const all = [];
  for (let i = 0; i < monthsNeeded; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const yyyymmFirst = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;
    try {
      const r = await stockDay(stockNo, yyyymmFirst);
      all.push(...r);
    } catch { /* skip this month */ }
    if (i < monthsNeeded - 1) await new Promise((r) => setTimeout(r, 250));
  }
  const byDate = new Map();
  all.forEach((r) => byDate.set(r.date, r));
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// 上市個股收盤行情（含成交量、開高低收）— 全部上市股
// /exchangeReport/STOCK_DAY_ALL 比較完整
export async function stockDayAll() {
  return fetchJson('/exchangeReport/STOCK_DAY_ALL');
}

// 個股月平均（與當日收盤）
export async function stockDayAvgAll() {
  return fetchJson('/exchangeReport/STOCK_DAY_AVG_ALL');
}

// 漲幅前 20（盤後）
export async function topGainers() {
  return fetchJson('/exchangeReport/MI_INDEX20');
}

// 三大法人買賣超合計（盤中常維護中，盤後 14:30 後穩定）
export async function institutional() {
  return fetchJson('/fund/BFI82U');
}

// 三大法人個股買賣超
export async function institutionalByStock() {
  return fetchJson('/fund/T86');
}

// 融資融券（每日彙總）
export async function margin() {
  return fetchJson('/exchangeReport/MI_MARGN');
}

// 個股殖利率/本益比/股價淨值比
export async function bwibbu() {
  return fetchJson('/exchangeReport/BWIBBU_ALL');
}
