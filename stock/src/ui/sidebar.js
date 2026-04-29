import { themes, industries } from '../data/mock.js';
import { state, emit } from '../state.js';
import { sign, colorOf } from '../utils/format.js';

export function mount() {
  document.getElementById('themes').innerHTML = themes.map((t) => `
    <div class="theme-card ${t.hot ? 'hot' : ''}" data-theme="${t.id}">
      <div class="tname">${t.name}</div>
      <div class="tdesc">${t.desc}</div>
      <div class="tstat">
        <div><div class="lab">產業漲幅</div><span style="color:${colorOf(t.chg)}">${sign(t.chg)}%</span></div>
        <div><div class="lab">代表股</div>${t.leaders.slice(0, 3).join(' · ')}</div>
      </div>
    </div>
  `).join('');

  document.querySelectorAll('.theme-card').forEach((c) => {
    c.addEventListener('click', () => {
      const t = themes.find((x) => x.id === c.dataset.theme);
      if (t && t.leaders[0] && state.stocks[t.leaders[0]]) emit('select', t.leaders[0]);
    });
  });

  document.getElementById('industries').innerHTML = industries.map((i) =>
    `<button data-ind="${i.name}"><span>${i.name}</span><span class="pct" style="color:${colorOf(i.chg)}">${sign(i.chg)}%</span></button>`
  ).join('');

  document.querySelectorAll('.industry-list button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.industry-list button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const i = industries.find((x) => x.name === b.dataset.ind);
      if (i && state.stocks[i.lead]) emit('select', i.lead);
    });
  });
}
