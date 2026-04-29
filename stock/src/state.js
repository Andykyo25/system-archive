// 集中狀態 + 簡單 pub/sub
const listeners = new Map();

export const state = {
  session: 'closed',         // pre / live / after / closed
  serverOnline: false,       // 後端是否回應
  currentCode: '2330',
  heatFilter: 'all',
  indices: null,             // { taiex, otc, sox, ... }
  stocks: {},                // code -> meta（初始來自 mock，盤中價以快照覆寫）
  movers: { gainers: [], losers: [] },
  flow: [],                  // 三大法人盤中
  postmarket: null,          // TWSE 盤後彙整
};

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
