// 排行榜 — 資料層（UI 已併入 AI 智選，本檔僅作為資料抓取與廣播）
// 候選池採「三層 Universe Selection」：
//   L1 核心池：mock.js 主流題材 35 檔
//   L2 持股池：用戶 Supabase 持股
//   L3 熱錢池：當日成交金額/漲幅榜 Top 20
// 三層去重、上限 70 檔（避免並發爆掉 + 5 min cache 內變動小）
import { state, emit, on } from '../state.js';
import { stocks as mockStocks } from '../data/mock.js';
import { api } from '../data/api.js';

let lastResult = [];
let lastUniverseMeta = { core: 0, holdings: 0, hot: 0, total: 0 };
let timer = null;
const UNIVERSE_CAP = 70;

export function mount() {
  // 監聽手動觸發
  on('ranking:reload', () => load());
  // 啟動後 3 秒延遲 load（讓 scheduler / state 先穩定下來，避免冷啟太擠）
  setTimeout(() => load(), 3000);
  // 盤中每 10 分鐘背景更新
  timer = setInterval(() => {
    if (state.session === 'live' || state.session === 'pre') load();
  }, 10 * 60 * 1000);
}

// 三層 universe 拼裝（L3 熱錢池目前停用 — Cnyes/FinMind 被 rate limit）
// 預設只用 L1 核心 + L2 持股，避免一次掃 60+ 檔把 provider 打爆
async function buildUniverse() {
  const set = new Set();
  Object.keys(mockStocks).forEach((c) => set.add(c));
  const coreCount = set.size;

  let holdingsAdded = 0;
  try {
    const holdings = await api.portfolioList();
    (holdings || []).filter((h) => h.status === 'active').forEach((h) => {
      if (h.code && !set.has(h.code)) {
        set.add(h.code);
        holdingsAdded++;
      }
    });
  } catch { /* skip */ }

  const universe = [...set].slice(0, UNIVERSE_CAP);
  lastUniverseMeta = {
    core: coreCount,
    holdings: holdingsAdded,
    hot: 0,                  // L3 暫關
    total: universe.length,
  };
  return universe;
}

async function load() {
  try {
    const codes = await buildUniverse();
    const result = await api.ranking(codes, { limit: codes.length });
    lastResult = result || [];
    emit('ranking:updated', { result: lastResult, meta: lastUniverseMeta });
  } catch (e) {
    console.warn('[ranking]', e.message);
  }
}

export function loadNow() { return load(); }
export function getMeta() { return lastUniverseMeta; }

export function getLastResult() {
  return lastResult;
}
