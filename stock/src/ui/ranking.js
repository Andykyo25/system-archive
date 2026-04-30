// 短線勝率排行榜
import { state, emit, on } from '../state.js';
import { fmt, sign, pctClass } from '../utils/format.js';
import { stocks as mockStocks } from '../data/mock.js';
import { api } from '../data/api.js';

let tbodyEl, infoEl, budgetEl, minWinEl, refreshBtn;
let lastResult = [];
let timer = null;

export function mount() {
  tbodyEl = document.getElementById('ranking-tbody');
  infoEl = document.getElementById('ranking-info');
  budgetEl = document.getElementById('rk-budget');
  minWinEl = document.getElementById('rk-minwin');
  refreshBtn = document.getElementById('rk-refresh');

  refreshBtn.addEventListener('click', () => load(true));
  budgetEl.addEventListener('change', () => render());
  minWinEl.addEventListener('change', () => render());

  // 啟動載入 + 盤中每 5 分鐘自動重整
  load();
  timer = setInterval(() => {
    if (state.session === 'live' || state.session === 'pre') load();
  }, 5 * 60 * 1000);
}

async function load(force = false) {
  const codes = Object.keys(mockStocks);
  if (force) tbodyEl.innerHTML = '<tr><td colspan="10" style="color:var(--dim);text-align:center;padding:20px">重新評估中…</td></tr>';
  try {
    const t0 = Date.now();
    const result = await api.ranking(codes, { limit: codes.length });
    lastResult = result || [];
    const ms = Date.now() - t0;
    infoEl.textContent = `掃描 ${codes.length} 檔候選股 · 取得 ${lastResult.length} 筆 · 耗時 ${ms} ms · 點擊列即可查看詳情`;
    render();
  } catch (e) {
    tbodyEl.innerHTML = `<tr><td colspan="10" style="color:var(--down);text-align:center;padding:20px">載入失敗：${e.message}</td></tr>`;
  }
}

function render() {
  if (!lastResult.length) {
    tbodyEl.innerHTML = '<tr><td colspan="10" style="color:var(--dim);text-align:center">沒有資料</td></tr>';
    return;
  }
  const budget = +budgetEl.value || 0;
  const minWin = +minWinEl.value || 0;

  let arr = lastResult;
  if (minWin > 0) arr = arr.filter((r) => r.winRate >= minWin);
  if (budget > 0) arr = arr.filter((r) => r.costPerLot <= budget);

  if (!arr.length) {
    tbodyEl.innerHTML = `<tr><td colspan="10" style="color:var(--dim);text-align:center">符合條件的股票為 0 ・ 試試降低勝率門檻或提高預算</td></tr>`;
    return;
  }

  arr = arr.slice(0, 12); // 最多顯示 12 檔

  const subTone = (v) => v >= 65 ? 's-hi' : v >= 50 ? 's-md' : 's-lo';
  const winTone = (v) => v >= 65 ? 'high' : v >= 50 ? 'mid' : 'low';

  tbodyEl.innerHTML = arr.map((r, i) => {
    const overBudget = budget && r.costPerLot > budget;
    const meta = mockStocks[r.code] || {};
    const sub = r.subScores || {};
    return `
      <tr data-code="${r.code}">
        <td class="rk-rank">${i + 1}</td>
        <td class="rk-name">
          <div class="n">${meta.name || r.code}</div>
          <div class="c">${r.code} · ${meta.industry || '-'}</div>
        </td>
        <td>${fmt(r.close, 2)}</td>
        <td class="rk-pct ${pctClass(r.pct)}">${r.pct != null ? sign(r.pct) + '%' : '--'}</td>
        <td class="rk-cost ${overBudget ? 'over' : ''}">${fmt(r.costPerLot, 0)}</td>
        <td class="rk-win ${winTone(r.winRate)}">${r.winRate}%</td>
        <td>
          <div class="rk-sub">
            <span class="${subTone(sub.trend)}">趨${sub.trend ?? '-'}</span>
            <span class="${subTone(sub.momentum)}">動${sub.momentum ?? '-'}</span>
            <span class="${subTone(sub.volPrice)}">量${sub.volPrice ?? '-'}</span>
            <span class="${subTone(sub.chip)}">籌${sub.chip ?? '-'}</span>
          </div>
        </td>
        <td class="rk-conclusion">${r.overall || '-'}<br><span style="color:var(--dim);font-size:10px">${r.mainForce || ''}</span></td>
        <td>${fmt(r.entry?.low, 0)}~${fmt(r.entry?.high, 0)}</td>
        <td><span style="color:var(--down)">${fmt(r.stop, 0)}</span> / <span style="color:var(--up)">${fmt(r.target, 0)}</span></td>
      </tr>
    `;
  }).join('');

  // 點擊跳轉
  tbodyEl.querySelectorAll('tr[data-code]').forEach((tr) => {
    tr.addEventListener('click', () => {
      emit('select', tr.dataset.code);
      document.getElementById('stock-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // 通知 portfolio.js 更新（共用同一份排行）
  emit('ranking:updated', lastResult);
}

export function getLastResult() {
  return lastResult;
}
