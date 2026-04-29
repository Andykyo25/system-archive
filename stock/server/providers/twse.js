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
