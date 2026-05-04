// FinMind API — 盤中即時 + 歷史資料
// 文件：https://finmindtrade.com/analysis/#/data/get
// dataset 命名：TaiwanStockPrice、TaiwanStockInfo、TaiwanStockInstitutionalInvestorsBuySell、
//   TaiwanStockMarginPurchaseShortSale、TaiwanStockMonthRevenue、TaiwanStockFinancialStatements、
//   TaiwanVariousIndicators5Seconds（盤中指數）、TaiwanStockTickSnapshot（盤中報價快照）

const BASE = 'https://api.finmindtrade.com/api/v4/data';

let TOKEN = '';
export function setToken(t) { TOKEN = t || ''; }

// Circuit breaker — 一旦遇到 402/403/429 立即冷卻 1 小時，所有後續呼叫直接 throw（不再打 API）
// 解決 quota 耗盡後仍對 FinMind 硬幹、拖慢 diag 整體速度的問題
let circuitUntil = 0;
const COOLDOWN_MS = 60 * 60 * 1000;
const STATUS_OPEN_CIRCUIT = new Set([402, 403, 429]);

export function circuitStatus() {
  return {
    open: Date.now() < circuitUntil,
    cooldownEndsAt: circuitUntil ? new Date(circuitUntil).toISOString() : null,
  };
}

async function call(dataset, params = {}) {
  if (Date.now() < circuitUntil) {
    throw new Error(`finmind circuit open (cooldown until ${new Date(circuitUntil).toISOString().slice(11, 19)})`);
  }
  const url = new URL(BASE);
  url.searchParams.set('dataset', dataset);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (STATUS_OPEN_CIRCUIT.has(res.status)) {
      circuitUntil = Date.now() + COOLDOWN_MS;
      console.warn(`[finmind] circuit opened (HTTP ${res.status}) — 1 小時內所有 FinMind 呼叫直接 fallback`);
    }
    throw new Error(`finmind ${dataset} HTTP ${res.status}`);
  }
  const json = await res.json();
  // FinMind 有時 200 但 status 402（quota exceeded as JSON body）
  if (json.status !== 200) {
    if (STATUS_OPEN_CIRCUIT.has(json.status)) {
      circuitUntil = Date.now() + COOLDOWN_MS;
      console.warn(`[finmind] circuit opened (status=${json.status}) — 1 小時內 fallback`);
    }
    throw new Error(`finmind ${dataset} status=${json.status} msg=${json.msg}`);
  }
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

// 流通／發行股數 — 取最新一筆
export async function sharesOutstanding(stock_id) {
  // 嘗試 TaiwanStockShareholding（含 NumberOfSharesIssued / 外資投資餘額等欄位）
  const start = new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);
  const rows = await call('TaiwanStockShareholding', { data_id: stock_id, start_date: start });
  if (!rows.length) return null;
  const latest = rows[rows.length - 1];
  // 嘗試多個常見欄位名（FinMind 不同時期 schema 略有差異）
  const candidates = [
    'NumberOfSharesIssued',
    'IssuedShares',
    'TotalNumberOfSharesIssued',
    'ForeignInvestmentLimitationShares', // 為已發行總額（外資上限 = 100%）
  ];
  for (const f of candidates) {
    const v = +latest[f];
    if (Number.isFinite(v) && v > 0) {
      return { date: latest.date, sharesOutstanding: v, raw: latest, field: f };
    }
  }
  return { date: latest.date, sharesOutstanding: null, raw: latest, field: null };
}

// 大戶／散戶持股結構（依持股級距）
export function majorShareholder(stock_id, start_date) {
  return call('TaiwanStockHoldingSharesPer', { data_id: stock_id, start_date });
}
