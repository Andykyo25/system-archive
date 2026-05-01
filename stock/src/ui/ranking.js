// 排行榜 — 資料層（UI 已併入 AI 智選，本檔僅作為資料抓取與廣播）
import { state, emit } from '../state.js';
import { stocks as mockStocks } from '../data/mock.js';
import { api } from '../data/api.js';

let lastResult = [];
let timer = null;

export function mount() {
  load();
  timer = setInterval(() => {
    if (state.session === 'live' || state.session === 'pre') load();
  }, 5 * 60 * 1000);
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

export function getLastResult() {
  return lastResult;
}
