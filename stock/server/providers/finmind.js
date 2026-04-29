// FinMind API — 盤中即時 + 歷史資料
// 文件：https://finmindtrade.com/analysis/#/data/get
// dataset 命名：TaiwanStockPrice、TaiwanStockInfo、TaiwanStockInstitutionalInvestorsBuySell、
//   TaiwanStockMarginPurchaseShortSale、TaiwanStockMonthRevenue、TaiwanStockFinancialStatements、
//   TaiwanVariousIndicators5Seconds（盤中指數）、TaiwanStockTickSnapshot（盤中報價快照）

const BASE = 'https://api.finmindtrade.com/api/v4/data';

let TOKEN = '';
export function setToken(t) { TOKEN = t || ''; }

async function call(dataset, params = {}) {
  const url = new URL(BASE);
  url.searchParams.set('dataset', dataset);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`finmind ${dataset} HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 200) throw new Error(`finmind ${dataset} status=${json.status} msg=${json.msg}`);
  return json.data || [];
}

// 個股日線
export function stockPrice(stock_id, start_date, end_date) {
  return call('TaiwanStockPrice', { data_id: stock_id, start_date, end_date });
}

// 三大法人個股
export function institutional(stock_id, start_date, end_date) {
  return call('TaiwanStockInstitutionalInvestorsBuySell', { data_id: stock_id, start_date, end_date });
}

// 融資融券
export function margin(stock_id, start_date, end_date) {
  return call('TaiwanStockMarginPurchaseShortSale', { data_id: stock_id, start_date, end_date });
}

// 月營收
export function monthRevenue(stock_id, start_date) {
  return call('TaiwanStockMonthRevenue', { data_id: stock_id, start_date });
}

// 財報
export function financial(stock_id, start_date) {
  return call('TaiwanStockFinancialStatements', { data_id: stock_id, start_date });
}

// 上市股票清單
export function stockInfo() {
  return call('TaiwanStockInfo');
}

// 盤中即時指數（每 5 秒）— TaiwanVariousIndicators5Seconds
export function liveIndices(start_date) {
  return call('TaiwanVariousIndicators5Seconds', { start_date });
}

// 盤中個股快照（最近報價 / 五檔等）
export function tickSnapshot(stock_id) {
  return call('TaiwanStockTickSnapshot', { data_id: stock_id });
}
