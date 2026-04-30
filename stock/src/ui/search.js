// 個股搜尋：輸入代號或名稱即時建議，按 Enter 跳轉並建立即時分析
import { state, emit } from '../state.js';
import { api } from '../data/api.js';
import { stocks as mockStocks } from '../data/mock.js';

let inputEl, suggestEl;
let allStocks = [];   // [{ code, name, industry }]
let activeIdx = -1;
let lastQuery = '';

export async function mount() {
  inputEl = document.getElementById('search-input');
  suggestEl = document.getElementById('search-suggest');

  // 載入全市場股票清單（FinMind）
  try {
    const list = await api.stocks();
    allStocks = (list || [])
      .filter((s) => s.type === 'twse' || s.type === 'tpex' || /^\d{4,6}$/.test(s.stock_id))
      .map((s) => ({
        code: s.stock_id,
        name: s.stock_name,
        industry: s.industry_category || '-',
        type: s.type,
      }));
  } catch (e) {
    console.warn('[search] FinMind stock list failed, fallback to mock', e.message);
    allStocks = Object.entries(mockStocks).map(([code, s]) => ({
      code, name: s.name, industry: s.industry, type: 'twse',
    }));
  }

  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('keydown', onKeyDown);
  inputEl.addEventListener('focus', () => { if (lastQuery) onInput(); });
  document.addEventListener('click', (e) => {
    if (!inputEl.contains(e.target) && !suggestEl.contains(e.target)) hide();
  });
}

function onInput() {
  const q = inputEl.value.trim().toLowerCase();
  lastQuery = q;
  activeIdx = -1;
  if (!q) { hide(); return; }

  // 過濾：代號開頭 > 名稱包含 > 產業包含
  const exactCode = allStocks.filter((s) => s.code === q);
  const codeStarts = allStocks.filter((s) => s.code.startsWith(q) && !exactCode.includes(s));
  const nameMatch = allStocks.filter((s) => s.name.toLowerCase().includes(q) && !exactCode.includes(s) && !codeStarts.includes(s));

  const matches = [...exactCode, ...codeStarts, ...nameMatch].slice(0, 10);

  if (!matches.length) {
    suggestEl.innerHTML = `<div class="si-empty">查無「${q}」相關個股</div>`;
    suggestEl.style.display = 'block';
    return;
  }

  suggestEl.innerHTML = matches.map((s, i) => `
    <div class="suggest-item ${i === activeIdx ? 'active' : ''}" data-code="${s.code}">
      <span class="si-code">${s.code}</span>
      <span class="si-name">${s.name}</span>
      <span class="si-ind">${s.industry}</span>
    </div>
  `).join('');
  suggestEl.style.display = 'block';

  suggestEl.querySelectorAll('.suggest-item').forEach((el) => {
    el.addEventListener('click', () => pick(el.dataset.code));
  });
}

function onKeyDown(e) {
  const items = suggestEl.querySelectorAll('.suggest-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIdx = Math.min(items.length - 1, activeIdx + 1);
    updateActive(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx = Math.max(0, activeIdx - 1);
    updateActive(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = activeIdx >= 0 ? items[activeIdx] : items[0];
    if (target) pick(target.dataset.code);
  } else if (e.key === 'Escape') {
    hide();
    inputEl.blur();
  }
}

function updateActive(items) {
  items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  items[activeIdx]?.scrollIntoView({ block: 'nearest' });
}

function pick(code) {
  if (!code) return;
  // 確保 state.stocks 內有此 code（即使不在 mock pool）
  if (!state.stocks[code]) {
    const s = allStocks.find((x) => x.code === code);
    state.stocks[code] = {
      name: s?.name || code,
      industry: s?.industry || '-',
      theme: [],
      price: null, chg: null, pct: null,
    };
  }
  hide();
  inputEl.value = '';
  emit('select', code);
  document.getElementById('stock-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hide() {
  suggestEl.style.display = 'none';
  activeIdx = -1;
}
