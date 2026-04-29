// 盤後精準資料 — TWSE OpenAPI 彙整
import { api } from '../data/api.js';
import { fmt, sign, rocToIso } from '../utils/format.js';

let statsEl, instEl, marginTbody, dateEl, refreshBtn;

export function mount() {
  statsEl = document.getElementById('post-stats');
  instEl = document.getElementById('post-inst');
  marginTbody = document.querySelector('#post-margin-table tbody');
  dateEl = document.getElementById('post-date');
  refreshBtn = document.getElementById('post-refresh');
  refreshBtn.addEventListener('click', () => { load(true); });
  load();
}

export async function load(force = false) {
  statsEl.innerHTML = `<div class="stat"><div class="l">載入中</div><div class="v">…</div></div>`;
  try {
    const d = await api.postmarket();
    render(d);
  } catch (e) {
    statsEl.innerHTML = `<div class="stat"><div class="l">錯誤</div><div class="v" style="font-size:13px;color:var(--down)">${e.message}</div></div>`;
  }
}

function render(d) {
  const date = d.date ? rocToIso(d.date) || d.date : '';
  dateEl.textContent = `證交所 OpenAPI · ${date}`;

  // ── 大盤指數摘要 ──
  const idx = d.indices || [];
  const find = (n) => idx.find((r) => r.指數 === n);
  const stat = (lab, row) => {
    if (!row) return `<div class="stat"><div class="l">${lab}</div><div class="v">--</div></div>`;
    const dir = row.漲跌 === '-' ? -1 : 1;
    const cls = dir > 0 ? 'up' : 'down';
    return `<div class="stat">
      <div class="l">${lab}</div>
      <div class="v ${cls}">${fmt(+row.收盤指數, 2)}</div>
      <div style="font-size:11px;color:var(--dim);margin-top:4px">${dir > 0 ? '+' : '-'}${row.漲跌點數} (${dir > 0 ? '+' : '-'}${row.漲跌百分比}%)</div>
    </div>`;
  };

  const stats3 = [
    stat('加權指數', find('發行量加權股價指數')),
    stat('臺灣 50',   find('臺灣50指數')),
    stat('電子類',    find('電子類指數')),
    stat('金融類',    find('金融類指數')),
    stat('半導體',    find('半導體類指數')),
    stat('航運類',    find('航運類指數')),
  ].join('');
  statsEl.innerHTML = stats3 || `<div class="stat"><div class="l">指數</div><div class="v">--</div></div>`;

  // ── 三大法人 ──
  const inst = d.institutional;
  if (Array.isArray(inst) && inst.length) {
    instEl.innerHTML = inst.map((r) => {
      const name = r.單位名稱 || r['單位'] || r.投資人 || Object.values(r)[0];
      const buy = +(String(r.買進金額 || r.買進 || '').replace(/,/g, '')) / 1e8;
      const sell = +(String(r.賣出金額 || r.賣出 || '').replace(/,/g, '')) / 1e8;
      const net = buy - sell;
      return `<tr>
        <td>${name}</td>
        <td>${fmt(buy, 2)}</td>
        <td>${fmt(sell, 2)}</td>
        <td class="${net > 0 ? 'up' : 'down'}"><b>${sign(net)}</b></td>
      </tr>`;
    }).join('');
  } else {
    const err = d.errors?.institutional;
    instEl.innerHTML = `<tr><td colspan="4" style="color:var(--dim);text-align:center">${err || '盤中時段尚未發布，14:30 後可取'}</td></tr>`;
  }

  // ── 融資融券彙總 ──
  const margin = d.margin;
  if (Array.isArray(margin) && margin.length) {
    // MI_MARGN 是個股表，非彙總；前端 group 一下
    let total = { buy: 0, sell: 0, sBalance: 0 };
    margin.forEach((r) => {
      total.buy += +r.融資買進 || 0;
      total.sell += +r.融資賣出 || 0;
      total.sBalance += +r.融券今日餘額 || 0;
    });
    marginTbody.innerHTML = `
      <tr><td>融資買進總計</td><td>${fmt(total.buy, 0)} 張</td></tr>
      <tr><td>融資賣出總計</td><td>${fmt(total.sell, 0)} 張</td></tr>
      <tr><td>融資增減</td><td class="${(total.buy - total.sell) > 0 ? 'up' : 'down'}">${sign(total.buy - total.sell)} 張</td></tr>
      <tr><td>融券餘額總計</td><td>${fmt(total.sBalance, 0)} 張</td></tr>
      <tr><td>個股檔數</td><td>${margin.length}</td></tr>
    `;
  } else {
    marginTbody.innerHTML = `<tr><td colspan="2" style="color:var(--dim);text-align:center">${d.errors?.margin || '無資料'}</td></tr>`;
  }
}
