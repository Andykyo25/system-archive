// 依交易時段決定 polling 頻率
import { state, emit } from './state.js';
import { api } from './data/api.js';
import { stocks as mockStocks } from './data/mock.js';

// 主源 TWSE MIS（無 rate limit），盤中積極 polling
// 國際指數走 Yahoo（429 風險），server cache 60 秒，前端打多少都一樣
const FREQ = {
  live:   { indices: 3000,   quotes: 3000,  movers: 30000 }, // 盤中：指數 3s、quote 3s、movers 30s
  pre:    { indices: 10000,  quotes: 15000, movers: 60000 },
  after:  { indices: 30000,  quotes: 60000, movers: 60000 },
  closed: { indices: 300000, quotes: 600000, movers: 600000 },
};

let timers = { indices: null, quotes: null, movers: null };

export async function start() {
  // 初始 stocks 來自 mock，後續透過 quote API 覆蓋價格
  if (!Object.keys(state.stocks).length) {
    state.stocks = JSON.parse(JSON.stringify(mockStocks));
    emit('stocks:changed');
  }

  // 取一次 health 確認後端
  await pingHealth();
  await Promise.allSettled([loadIndices(), loadMovers(), bootstrapQuotes()]);

  scheduleAll();
  // 每 30 秒 ping 健康狀態並重排頻率
  setInterval(async () => {
    await pingHealth();
    scheduleAll();
  }, 30000);
}

async function pingHealth() {
  try {
    const h = await api.health();
    state.serverOnline = true;
    state.session = h.session || 'closed';
    emit('session:changed', state.session);
    emit('status:changed', { online: true, message: `後端在線 · ${h.session}` });
  } catch (e) {
    state.serverOnline = false;
    emit('status:changed', { online: false, message: '後端離線（請檢查 npm start）' });
  }
}

function scheduleAll() {
  const f = FREQ[state.session] || FREQ.closed;
  reschedule('indices', f.indices, loadIndices);
  reschedule('quotes', f.quotes, bootstrapQuotes);
  reschedule('movers', f.movers, loadMovers);
}

function reschedule(key, ms, fn) {
  if (timers[key]) clearInterval(timers[key]);
  timers[key] = setInterval(() => { fn().catch(() => {}); }, ms);
}

async function loadIndices() {
  if (!state.serverOnline) return;
  try {
    const d = await api.indices();
    state.indices = d;
    if (d?.session) {
      state.session = d.session;
      emit('session:changed', d.session);
    }
    emit('indices:changed');
  } catch (e) {
    console.warn('[indices]', e.message);
  }
}

async function bootstrapQuotes() {
  if (!state.serverOnline) return;
  const codes = Object.keys(state.stocks);
  if (!codes.length) return;
  try {
    const resp = await api.quotesBatch(codes);
    const data = resp?.quotes || resp;
    const errors = resp?.errors || {};
    let dirty = false;
    Object.entries(data).forEach(([code, q]) => {
      if (state.stocks[code] && q && q.price != null) {
        Object.assign(state.stocks[code], {
          price: q.price,
          prev: q.prev,
          chg: q.chg,
          pct: q.pct,
          open: q.open,
          dayHigh: q.dayHigh,
          dayLow: q.dayLow,
          volume: q.volume,
          time: q.time,
          // 五檔（MIS 才有）
          bid: q.bid,
          ask: q.ask,
          bidVol: q.bidVol,
          askVol: q.askVol,
          bestBid: q.bestBid,
          bestAsk: q.bestAsk,
          limitUp: q.limitUp,
          limitDown: q.limitDown,
          source: q.source,
        });
        dirty = true;
      }
    });
    const yahooCount = Object.values(data).filter((q) => q?.source === 'yahoo').length;
    const finmindCount = Object.values(data).filter((q) => q?.source === 'finmind').length;
    const errCount = Object.keys(errors).length;
    emit('status:changed', {
      online: true,
      message: `quote ✓ Yahoo:${yahooCount} FinMind:${finmindCount}${errCount ? ` Err:${errCount}` : ''}`,
    });
    if (dirty) emit('stocks:changed');
  } catch (e) {
    console.warn('[bootstrap]', e.message);
    emit('status:changed', { online: false, message: 'quote API 失敗：' + e.message });
  }
}

async function loadMovers() {
  if (!state.serverOnline) return;
  try {
    const d = await api.movers();
    state.movers = d;
    // ★ movers 來源是 TWSE STOCK_DAY_ALL（盤後彙整），盤中 = 昨日收盤資料
    // 不可覆寫 state.stocks 已存在的 live quote（會被昨日收盤蓋過漲停價）
    // 只在「該 code 尚未存在」時建立新 entry，提供 movers list 顯示用
    let dirty = false;
    [...(d.gainers || []), ...(d.losers || [])].forEach((s) => {
      if (!state.stocks[s.code]) {
        state.stocks[s.code] = {
          name: s.name, industry: '-', theme: [],
          price: s.close, chg: (s.close - s.open) || 0, pct: s.pct,
          eps: 0, pe: 0, pb: 0, roe: 0, divYield: 0, mcap: '-',
        };
        dirty = true;
      }
      // 已存在 → 信任 bootstrapQuotes 的 MIS 即時價，跳過
    });
    if (dirty) emit('stocks:changed');
    emit('movers:changed');
  } catch (e) {
    console.warn('[movers]', e.message);
  }
}
