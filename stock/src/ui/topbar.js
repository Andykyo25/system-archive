import { state, on } from '../state.js';
import { sign, fmt, pctClass, pad, todayLabel } from '../utils/format.js';

const SESSION_LABEL = { live: '盤中 LIVE', pre: '盤前', after: '盤後彙整中', closed: '休市' };

let tickerEl, statusEl, statusText, sessionEl, clockEl, dateEl;

export function mount() {
  tickerEl = document.getElementById('ticker');
  statusEl = document.getElementById('status');
  statusText = document.getElementById('status-text');
  sessionEl = document.getElementById('session');
  clockEl = document.getElementById('clock');
  dateEl = document.getElementById('date');
  dateEl.textContent = todayLabel();

  setInterval(() => {
    const d = new Date();
    clockEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }, 1000);

  on('stocks:changed', renderTicker);
  on('session:changed', updateSession);
  on('status:changed', updateStatus);
}

function renderTicker() {
  const items = Object.entries(state.stocks)
    .filter(([, s]) => s.price != null) // 還沒灌入真實價的不顯示，避免 ticker 一片 --
    .map(([code, s]) =>
      `<span class="item"><span class="name">${s.name} ${code}</span> ${fmt(s.price, 2)} <span class="pct ${pctClass(s.pct)}">${sign(s.pct)}%</span></span>`
    ).join('');
  tickerEl.innerHTML = items + items;
}

function updateSession(session) {
  sessionEl.textContent = SESSION_LABEL[session] || session;
  sessionEl.className = 'session-tag ' + (session || '');
}

function updateStatus({ online, message }) {
  statusEl.className = 'status-pill ' + (online ? 'ok' : 'err');
  statusText.textContent = message || (online ? '連線正常' : '後端離線');
}
