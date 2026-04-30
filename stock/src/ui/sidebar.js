import { themes, industries, stocks as mockStocks } from '../data/mock.js';
import { state, emit, on } from '../state.js';
import { sign, fmt, colorOf } from '../utils/format.js';

let expandedTheme = null;
let expandedIndustry = null;

export function mount() {
  renderThemes();
  renderIndustries();

  // 即時報價更新時重畫展開項目
  on('stocks:changed', () => {
    if (expandedTheme || expandedIndustry) {
      renderThemes();
      renderIndustries();
    }
  });
}

// ─── 題材 ───
function renderThemes() {
  const box = document.getElementById('themes');
  box.innerHTML = themes.map((t) => {
    const expanded = expandedTheme === t.id;
    const list = expanded ? buildThemeList(t) : '';
    return `
      <div class="theme-card ${t.hot ? 'hot' : ''} ${expanded ? 'expanded' : ''}" data-theme="${t.id}">
        <div class="theme-card-head">
          <div class="tname">${t.name}</div>
          <div class="tdesc">${t.desc}</div>
          <div class="tstat">
            <div><div class="lab">產業漲幅</div><span style="color:${colorOf(t.chg)}">${sign(t.chg)}%</span></div>
            <div><div class="lab">代表股</div>${t.leaders.slice(0, 3).join(' · ')}</div>
          </div>
        </div>
        ${list}
      </div>
    `;
  }).join('');

  // 點 head 展開/收起；點內部 stock-row 跳轉
  document.querySelectorAll('.theme-card').forEach((card) => {
    card.querySelector('.theme-card-head')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = card.dataset.theme;
      expandedTheme = expandedTheme === id ? null : id;
      renderThemes();
    });
    card.querySelectorAll('.stock-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        emit('select', row.dataset.code);
      });
    });
  });
}

function buildThemeList(theme) {
  // 先把題材內所有股票（從 state.stocks 過濾 theme[] 包含此 id），不夠 10 檔就用 leaders 補
  const inTheme = Object.entries(state.stocks)
    .filter(([_, s]) => (s.theme || []).includes(theme.id))
    .map(([code, s]) => ({ code, ...s }));

  // 加進 leaders 中尚未在 mock 的代號（顯示為待載入）
  for (const code of theme.leaders) {
    if (!inTheme.find((x) => x.code === code)) {
      const meta = mockStocks[code];
      inTheme.push({ code, name: meta?.name || code, industry: meta?.industry || '-', price: null, pct: null });
    }
  }

  // 依漲跌幅排序（null 排最後）
  inTheme.sort((a, b) => {
    if (a.pct == null && b.pct == null) return 0;
    if (a.pct == null) return 1;
    if (b.pct == null) return -1;
    return (b.pct || 0) - (a.pct || 0);
  });
  const top10 = inTheme.slice(0, 10);

  if (!top10.length) return '<div class="theme-empty">無資料</div>';

  return `
    <div class="theme-stocks">
      ${top10.map((s) => `
        <div class="stock-row" data-code="${s.code}">
          <span class="sr-code">${s.code}</span>
          <span class="sr-name">${s.name}</span>
          <span class="sr-pct ${s.pct > 0 ? 'up' : s.pct < 0 ? 'down' : ''}">${s.pct == null ? '--' : sign(s.pct) + '%'}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// ─── 產業 ───
function renderIndustries() {
  const box = document.getElementById('industries');
  box.innerHTML = industries.map((i) => {
    const expanded = expandedIndustry === i.name;
    const list = expanded ? buildIndustryList(i) : '';
    return `
      <div class="industry-item ${expanded ? 'expanded' : ''}" data-ind="${i.name}">
        <button class="industry-head">
          <span>${i.name}</span>
          <span class="pct" style="color:${colorOf(i.chg)}">${sign(i.chg)}%</span>
        </button>
        ${list}
      </div>
    `;
  }).join('');

  document.querySelectorAll('.industry-item').forEach((item) => {
    item.querySelector('.industry-head')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = item.dataset.ind;
      expandedIndustry = expandedIndustry === name ? null : name;
      renderIndustries();
    });
    item.querySelectorAll('.stock-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        emit('select', row.dataset.code);
      });
    });
  });
}

function buildIndustryList(ind) {
  const inIndustry = Object.entries(state.stocks)
    .filter(([_, s]) => s.industry === ind.name)
    .map(([code, s]) => ({ code, ...s }));

  // 加上 lead 如果不在
  if (!inIndustry.find((x) => x.code === ind.lead)) {
    const meta = mockStocks[ind.lead];
    if (meta) {
      inIndustry.push({ code: ind.lead, name: meta.name, industry: meta.industry, price: null, pct: null });
    }
  }

  inIndustry.sort((a, b) => {
    if (a.pct == null && b.pct == null) return 0;
    if (a.pct == null) return 1;
    if (b.pct == null) return -1;
    return (b.pct || 0) - (a.pct || 0);
  });
  const top10 = inIndustry.slice(0, 10);

  if (!top10.length) {
    return `<div class="theme-empty">候選池暫無此產業股票</div>`;
  }

  return `
    <div class="theme-stocks">
      ${top10.map((s) => `
        <div class="stock-row" data-code="${s.code}">
          <span class="sr-code">${s.code}</span>
          <span class="sr-name">${s.name}</span>
          <span class="sr-pct ${s.pct > 0 ? 'up' : s.pct < 0 ? 'down' : ''}">${s.pct == null ? '--' : sign(s.pct) + '%'}</span>
        </div>
      `).join('')}
    </div>
  `;
}
