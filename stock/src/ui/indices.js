import { state, on } from '../state.js';
import { fmt, sign } from '../utils/format.js';
import { mountChart, theme } from './charts.js';

const KEYS = [
  { key: 'taiex', label: '加權指數',  tag: 'TAIEX', isInt: false },
  { key: 'otc',   label: '櫃買指數',  tag: 'OTC',   isInt: false },
  { key: 'sox',   label: '費半',      tag: 'SOX',   isInt: false },
  { key: 'ixic',  label: 'NASDAQ',    tag: 'IXIC',  isInt: true  },
];

const cardEls = {};

export function mount() {
  const box = document.getElementById('indices');
  box.innerHTML = KEYS.map((k) => `
    <div class="index-card" data-k="${k.key}">
      <div class="lab">${k.label} · ${k.tag}</div>
      <div class="val" data-f="val">--</div>
      <div class="delta" data-f="delta">--</div>
      <div class="mini"><canvas id="mini-${k.key}"></canvas></div>
      <div class="meta"><span data-f="meta">--</span></div>
    </div>
  `).join('');
  KEYS.forEach((k) => { cardEls[k.key] = box.querySelector(`[data-k="${k.key}"]`); });
  on('indices:changed', update);
}

function update() {
  const i = state.indices || {};
  KEYS.forEach((k) => {
    const card = cardEls[k.key];
    if (!card) return;
    const data = i[k.key];
    if (!data || data.close == null) {
      card.querySelector('[data-f="val"]').textContent = '--';
      card.querySelector('[data-f="delta"]').textContent = '--';
      return;
    }
    const change = data.change ?? 0;
    const pct = data.pct ?? (data.prevClose ? ((data.close - data.prevClose) / data.prevClose) * 100 : 0);
    card.classList.remove('up', 'down');
    if (change > 0) card.classList.add('up');
    else if (change < 0) card.classList.add('down');
    card.querySelector('[data-f="val"]').textContent = fmt(data.close, k.isInt ? 0 : 2);
    card.querySelector('[data-f="delta"]').textContent = `${sign(change)} (${sign(pct)}%)`;
    const meta = card.querySelector('[data-f="meta"]');
    meta.textContent = data.note || '';

    // mini chart：只在第一次或資料明顯變動時重畫
    if (!card.dataset.charted || Math.abs(+card.dataset.lastClose - data.close) > 0.5) {
      drawMini(k.key, data.close, change);
      card.dataset.charted = '1';
      card.dataset.lastClose = data.close;
    }
  });
}

function drawMini(key, base, chg) {
  const len = 30;
  const arr = Array.from({ length: len }, (_, k) =>
    base + (Math.sin(k / 3) + Math.random() - 0.5) * base * 0.003 - (len - 1 - k) * chg / len
  );
  mountChart(`mini-${key}`, {
    type: 'line',
    data: { labels: arr.map((_, j) => j), datasets: [{
      data: arr, borderColor: chg > 0 ? '#ff3b4e' : '#1ed760', borderWidth: 1.4,
      pointRadius: 0, fill: true,
      backgroundColor: chg > 0 ? 'rgba(255,59,78,.15)' : 'rgba(30,215,96,.15)', tension: .3,
    }]},
    options: {
      plugins: { legend: { display: false } },
      scales: { x: { display: false }, y: { display: false } },
      responsive: true, maintainAspectRatio: false, animation: false,
    },
  });
}
