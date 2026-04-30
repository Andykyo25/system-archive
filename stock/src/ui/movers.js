import { state, emit, on } from '../state.js';
import { fmt, sign } from '../utils/format.js';

let gainersEl, losersEl, sourceEl;

export function mount() {
  gainersEl = document.getElementById('gainers');
  losersEl  = document.getElementById('losers');
  sourceEl  = document.getElementById('movers-source');
  on('movers:changed', render);
  render();
}

function row(s, i) {
  const cls = s.pct > 0 ? 'up' : 'down';
  // 成交金額顯示：1 億以上用「X.X 億」、千萬用 「Y,YYY 萬」
  const tv = s.tradeValue ? (s.tradeValue >= 1e8 ? `${(s.tradeValue / 1e8).toFixed(1)}億` : `${(s.tradeValue / 1e4).toFixed(0)}萬`) : '';
  return `
    <div class="mover ${cls}" data-code="${s.code}">
      <div class="rank">${i + 1}</div>
      <div class="info">
        <div class="n">${s.name}</div>
        <div class="c">${s.code}${tv ? ' · ' + tv : ''}</div>
      </div>
      <div class="price"><div class="p">${fmt(s.close ?? s.price, 2)}</div><div class="pct">${sign(s.pct)}%</div></div>
    </div>`;
}

function render() {
  const m = state.movers || { gainers: [], losers: [] };
  const g = (m.gainers || []).slice(0, 8);
  const l = (m.losers  || []).slice(0, 8);

  // 若後端沒回，fallback 用 state.stocks 排序
  const fallback = !g.length;
  if (fallback) {
    const arr = Object.entries(state.stocks).map(([code, s]) => ({ code, ...s, close: s.price }));
    g.push(...arr.sort((a, b) => (b.pct || 0) - (a.pct || 0)).slice(0, 8));
    l.push(...arr.sort((a, b) => (a.pct || 0) - (b.pct || 0)).slice(0, 8));
  }

  gainersEl.innerHTML = g.map(row).join('');
  losersEl.innerHTML  = l.map(row).join('');
  // 顯示算法說明（為什麼這些股票上榜）
  if (m.algo) {
    sourceEl.textContent = `${m.algo}${m.totalScanned ? ` · 掃描 ${m.totalScanned} 檔` : ''}`;
  } else {
    sourceEl.textContent = `來源 ${m.source || (fallback ? 'mock' : '—')}`;
  }

  document.querySelectorAll('.mover').forEach((el) =>
    el.addEventListener('click', () => emit('select', el.dataset.code))
  );
}
