import { state, emit, on } from '../state.js';
import { sign } from '../utils/format.js';

const WEIGHTS = ['2330','2317','2454','2308','3711','2882','2382','6669','3231','2376'];

function color(p) {
  if (p == null || !Number.isFinite(p)) return '#1f2836'; // 無資料：暗灰
  if (p >= 7) return '#a01528';
  if (p >= 3) return '#ff3b4e';
  if (p >= 1) return '#cf2436';
  if (p > 0)  return '#5e2530';
  if (p === 0) return '#3a4252';
  if (p > -1) return '#1a4a35';
  if (p > -3) return '#0f6e3c';
  if (p > -7) return '#1ed760';
  return '#0a8c4d';
}

let box, filter = 'all';

export function mount() {
  box = document.getElementById('heatmap');
  document.querySelectorAll('[data-heat]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-heat]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      filter = b.dataset.heat;
      render();
    });
  });
  on('stocks:changed', render);
  render();
}

function render() {
  let arr = Object.entries(state.stocks).map(([code, s]) => ({ code, ...s }));
  if (filter === 'weight') arr = arr.filter((s) => WEIGHTS.includes(s.code));
  else if (filter !== 'all') arr = arr.filter((s) => (s.theme || []).includes(filter));
  box.innerHTML = arr.map((s) => `
    <div class="heat" style="background:${color(s.pct)};color:#fff" data-code="${s.code}">
      <div class="code">${s.code}</div>
      <div class="name">${s.name}</div>
      <div class="pct">${s.pct == null ? '--' : sign(s.pct) + '%'}</div>
    </div>`).join('');
  box.querySelectorAll('.heat').forEach((h) =>
    h.addEventListener('click', () => emit('select', h.dataset.code))
  );
}
