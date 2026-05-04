// 集中狀態 + 簡單 pub/sub
const listeners = new Map();

// F5 記住上次選的股票
const LAST_CODE_KEY = 'twr:lastCode';
let initialCode = '2330';
try {
  const saved = localStorage.getItem(LAST_CODE_KEY);
  if (saved && /^\d{4,6}$/.test(saved)) initialCode = saved;
} catch { /* localStorage 不可用 */ }

export const state = {
  session: 'closed',         // pre / live / after / closed
  serverOnline: false,       // 後端是否回應
  currentCode: initialCode,
  heatFilter: 'all',
  indices: null,             // { taiex, otc, sox, ... }
  stocks: {},                // code -> meta（初始來自 mock，盤中價以快照覆寫）
  movers: { gainers: [], losers: [] },
  flow: [],                  // 三大法人盤中
  postmarket: null,          // TWSE 盤後彙整
};

// 切股票時自動存
on('stock:selected', (code) => {
  if (code && /^\d{4,6}$/.test(code)) {
    try { localStorage.setItem(LAST_CODE_KEY, code); } catch {}
  }
});

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (set) for (const fn of set) {
    try { fn(payload); } catch (e) { console.error(`[emit ${event}]`, e); }
  }
}
