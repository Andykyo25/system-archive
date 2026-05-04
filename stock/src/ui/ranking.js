// 排行榜 — 資料層（UI 已併入 AI 智選，本檔僅作為資料抓取與廣播）
// ★ Lazy 模式：啟動不自動跑（避免 35 檔同時打 4 個 provider 造成 storm）
//    只有 user 點擊「重新配置」按鈕才觸發
import { state, emit, on } from '../state.js';
import { stocks as mockStocks } from '../data/mock.js';
import { api } from '../data/api.js';

let lastResult = [];
let timer = null;

export function mount() {
  // 不在啟動時自動 load — 等用戶按「重新配置」（portfolio.js 的按鈕觸發）
  // 監聽手動觸發事件
  on('ranking:reload', () => load());
  // 盤中每 10 分鐘自動更新（5 → 10 分降頻）
  timer = setInterval(() => {
    if (state.session === 'live' || state.session === 'pre') load();
  }, 10 * 60 * 1000);
}

async function load() {
  const codes = Object.keys(mockStocks);
  try {
    const result = await api.ranking(codes, { limit: codes.length });
    lastResult = result || [];
    emit('ranking:updated', lastResult);
  } catch (e) {
    console.warn('[ranking]', e.message);
  }
}

export function loadNow() { return load(); }

export function getLastResult() {
  return lastResult;
}
