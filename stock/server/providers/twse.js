// 證交所 OpenAPI — 盤後精準資料
// https://openapi.twse.com.tw/
// 注意：部分 endpoint 盤中時段會回 HTML 維護頁，呼叫端需 try/catch 並 fallback。

const BASE = 'https://openapi.twse.com.tw/v1';

async function fetchJson(path, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: ctrl.signal,
    });
    if (res.status !== 200) throw new Error(`twse ${path} status=${res.status}`);
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!ct.includes('json') && text.trim().startsWith('<')) {
      throw new Error(`twse ${path} returned HTML (likely maintenance / not yet published)`);
    }
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

// 大盤所有指數收盤
export async function indices() {
  return fetchJson('/exchangeReport/MI_INDEX');
}

// 個股單月日線歷史（傳 yyyymm01 格式日期）
// 直接打 www.twse.com.tw 不走 openapi（因為 openapi 沒有此端點）
export async function stockDay(stockNo, yyyymmFirst) {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${yyyymmFirst}&stockNo=${encodeURIComponent(stockNo)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);  // 8s（TWSE 有時較慢）
  let res, j;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-TW,zh;q=0.9',
        Referer: 'https://www.twse.com.tw/',
      },
    });
    if (!res.ok) throw new Error(`twse stockDay HTTP ${res.status}`);
    j = await res.json();
  } finally { clearTimeout(t); }
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

// 三大法人單日全市場買賣超（T86）— 免 quota 官方來源
// URL: /fund/T86?response=json&date=YYYYMMDD&selectType=ALL
export async function institutionalByDay(yyyymmdd) {
  const url = `https://www.twse.com.tw/fund/T86?response=json&date=${yyyymmdd}&selectType=ALL`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 TWSE-WarRoom/1.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`twse T86 HTTP ${res.status}`);
  const j = await res.json();
  if (j.stat !== 'OK') throw new Error(`twse T86 ${j.stat || 'no data'}`);
  const fields = j.fields || [];
  const idx = (kw) => fields.findIndex((f) => f && f.replace(/\s/g, '').includes(kw));
  const codeI = idx('證券代號');
  const nameI = idx('證券名稱');
  // 欄位名歷年略有差，做寬鬆比對
  const foreignI = fields.findIndex((f) => /外陸資.*買賣超.*不含/.test(f) || f === '外資買賣超股數');
  const trustI = fields.findIndex((f) => /^投信買賣超/.test(f));
  const totalI = fields.findIndex((f) => /三大法人.*買賣超/.test(f));
  if (codeI < 0 || foreignI < 0 || trustI < 0 || totalI < 0) {
    throw new Error('twse T86 欄位解析失敗');
  }
  const num = (s) => +String(s ?? '0').replace(/,/g, '') || 0;
  return (j.data || []).map((row) => {
    const code = String(row[codeI] || '').trim();
    if (!/^\d{4,6}$/.test(code)) return null;
    const foreign = num(row[foreignI]);
    const trust = num(row[trustI]);
    const total = num(row[totalI]);
    return {
      code,
      name: String(row[nameI] || '').trim(),
      foreign_net: Math.round(foreign / 1000),
      trust_net: Math.round(trust / 1000),
      dealer_net: Math.round((total - foreign - trust) / 1000),
      total_net: Math.round(total / 1000),
    };
  }).filter(Boolean);
}

// 拉 N 天日線歷史（內部分月撈 + 速率限制）— 給 K 線 fallback 用
export async function stockDayHistory(stockNo, days = 90) {
  const today = new Date();
  const monthsNeeded = Math.ceil(days / 22) + 1;
  const all = [];
  const errors = [];
  for (let i = 0; i < monthsNeeded; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const yyyymmFirst = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;
    try {
      const r = await stockDay(stockNo, yyyymmFirst);
      all.push(...r);
    } catch (e) {
      errors.push(`${yyyymmFirst}:${e.message}`);
    }
    if (i < monthsNeeded - 1) await new Promise((r) => setTimeout(r, 350));
  }
  // 全失敗才印（避免 log 暴增）
  if (!all.length && errors.length) {
    console.warn(`[twse stockDayHistory ${stockNo}] all months failed:`, errors.slice(0, 2).join(' | '));
  }
  const byDate = new Map();
  all.forEach((r) => byDate.set(r.date, r));
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// 拉某檔近 N 個交易日的三大法人（會跳過週末 + 沒資料的日期）
// 回傳 FinMind 相容格式：每天每法人各一列，含 buy/sell/name
export async function institutionalRecentForCode(stockNo, daysWanted = 5) {
  const out = [];
  const today = new Date();
  let collected = 0;
  let attempts = 0;
  while (collected < daysWanted && attempts < daysWanted * 3) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - attempts);
    attempts++;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const isoDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
      const all = await institutionalByDay(yyyymmdd);
      const r = all.find((x) => x.code === stockNo);
      if (r) {
        // 轉成 FinMind 相容（每法人一列、買賣分開）
        const expand = (label, net) => ({
          date: isoDate,
          name: label,
          buy: net > 0 ? net : 0,
          sell: net < 0 ? -net : 0,
        });
        out.push(expand('外資', r.foreign_net));
        out.push(expand('投信', r.trust_net));
        out.push(expand('自營商', r.dealer_net));
        collected++;
      }
    } catch { /* skip */ }
    if (collected < daysWanted) await new Promise((r) => setTimeout(r, 200));
  }
  return out;
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

// 全市場個股融資融券（單日，免 quota 官方）
// /rwd/zh/marginTrading/MI_MARGN?date=YYYYMMDD&selectType=ALL&response=json
// fields 範例：['股票代號','股票名稱','融資買進','融資賣出','現金償還','前資餘額','資餘額',
//            '融資限額','融券買進','融券賣出','現券償還','前券餘額','券餘額','融券限額','資券互抵','註記']
export async function marginByDay(yyyymmdd) {
  const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${yyyymmdd}&selectType=ALL&response=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  let res, j;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 TWSE-WarRoom/1.0',
        Accept: 'application/json',
        Referer: 'https://www.twse.com.tw/',
      },
    });
    if (!res.ok) throw new Error(`twse MI_MARGN HTTP ${res.status}`);
    j = await res.json();
  } finally { clearTimeout(t); }
  if (j.stat !== 'OK') throw new Error(`twse MI_MARGN ${j.stat || 'no data'}`);
  // 結構：tables[1].fields + tables[1].data （個股明細在 tables[1]）
  const tables = j.tables || [];
  const target = tables.find((t) => Array.isArray(t.data) && t.data.length > 100) || tables[1] || tables[0];
  if (!target || !Array.isArray(target.data)) throw new Error('twse MI_MARGN no detail table');
  const fields = target.fields || [];
  const idx = (...kws) => {
    for (const kw of kws) {
      const i = fields.findIndex((f) => f && f.replace(/\s/g, '').includes(kw));
      if (i >= 0) return i;
    }
    return -1;
  };
  const codeI = idx('股票代號', '證券代號');
  const marginBuyI = idx('融資買進');
  const marginSellI = idx('融資賣出');
  const marginBalI = idx('資餘額', '融資餘額');
  const shortBuyI = idx('融券買進');
  const shortSellI = idx('融券賣出');
  const shortBalI = idx('券餘額', '融券餘額');
  if (codeI < 0) throw new Error('twse MI_MARGN 欄位解析失敗');
  const num = (s) => +String(s ?? '0').replace(/,/g, '') || 0;
  return target.data.map((row) => {
    const code = String(row[codeI] || '').trim();
    if (!/^\d{4,6}$/.test(code)) return null;
    return {
      code,
      margin_buy: num(row[marginBuyI]),
      margin_sell: num(row[marginSellI]),
      margin_balance: num(row[marginBalI]),
      short_buy: num(row[shortBuyI]),
      short_sell: num(row[shortSellI]),
      short_balance: num(row[shortBalI]),
    };
  }).filter(Boolean);
}

// 個股殖利率/本益比/股價淨值比
export async function bwibbu() {
  return fetchJson('/exchangeReport/BWIBBU_ALL');
}
