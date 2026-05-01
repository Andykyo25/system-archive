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

  renderAnalysis(d);
}

// ──────── 盤後解讀文字 ────────
function renderAnalysis(d) {
  const box = document.getElementById('post-analysis-body');
  if (!box) return;

  const idx = d.indices || [];
  const find = (n) => idx.find((r) => r.指數 === n);
  const taiex = find('發行量加權股價指數');
  const elec  = find('電子類指數');
  const fin   = find('金融類指數');

  const pickPct = (row) => {
    if (!row) return null;
    const dir = row.漲跌 === '-' ? -1 : 1;
    return dir * +row.漲跌百分比;
  };
  const taiexPct = pickPct(taiex);
  const elecPct  = pickPct(elec);
  const finPct   = pickPct(fin);

  // 三大法人合計買賣超
  let netInst = null, foreignNet = null, trustNet = null;
  if (Array.isArray(d.institutional) && d.institutional.length) {
    const num = (s) => +(String(s || '').replace(/,/g, '')) || 0;
    let f = 0, t = 0, total = 0;
    d.institutional.forEach((r) => {
      const name = r.單位名稱 || r['單位'] || r.投資人 || '';
      const buy = num(r.買進金額 || r.買進);
      const sell = num(r.賣出金額 || r.賣出);
      const net = (buy - sell) / 1e8; // 億
      total += net;
      if (name.includes('外資')) f += net;
      else if (name.includes('投信')) t += net;
    });
    netInst = total;
    foreignNet = f;
    trustNet = t;
  }

  // 融資增減
  let marginDelta = null;
  if (Array.isArray(d.margin) && d.margin.length) {
    let buy = 0, sell = 0;
    d.margin.forEach((r) => { buy += +r.融資買進 || 0; sell += +r.融資賣出 || 0; });
    marginDelta = buy - sell;
  }

  if (taiexPct == null) {
    box.innerHTML = '<span style="color:var(--dim)">盤後資料尚未發布（14:30 後可取）</span>';
    return;
  }

  const lines = [];

  // 1. 大盤判讀
  const trend =
    taiexPct >= 1.5 ? { tag: '強勢', color: 'var(--up)' } :
    taiexPct >= 0.3 ? { tag: '偏多', color: 'var(--up)' } :
    taiexPct >= -0.3 ? { tag: '盤整', color: 'var(--gold)' } :
    taiexPct >= -1.5 ? { tag: '偏空', color: 'var(--down)' } :
                       { tag: '弱勢', color: 'var(--down)' };
  let line1 = `<b style="color:${trend.color}">大盤${trend.tag}</b> — 加權指數收 `;
  line1 += `<b>${(taiexPct >= 0 ? '+' : '') + taiexPct.toFixed(2)}%</b>。`;
  if (elecPct != null && finPct != null) {
    const lead = Math.abs(elecPct) > Math.abs(finPct) ? '電子' : '金融';
    line1 += `類股動能上 <b>${lead}類</b> 表現較顯著（電子 ${(elecPct >= 0 ? '+' : '') + elecPct.toFixed(2)}% / 金融 ${(finPct >= 0 ? '+' : '') + finPct.toFixed(2)}%）。`;
  }
  lines.push(line1);

  // 2. 法人籌碼
  if (netInst != null) {
    const netCls = netInst > 0 ? 'var(--up)' : netInst < 0 ? 'var(--down)' : 'var(--flat)';
    const word = netInst > 50 ? '大買' : netInst > 5 ? '偏多買超' : netInst > -5 ? '中性' : netInst > -50 ? '偏空賣超' : '大賣';
    let line2 = `<b style="color:${netCls}">法人${word}</b> — 三大法人合計 <b>${netInst >= 0 ? '+' : ''}${netInst.toFixed(2)} 億</b>`;
    line2 += `（外資 ${foreignNet >= 0 ? '+' : ''}${foreignNet.toFixed(2)} 億 / 投信 ${trustNet >= 0 ? '+' : ''}${trustNet.toFixed(2)} 億）。`;
    if (foreignNet > 0 && trustNet > 0) line2 += '外資+投信同向買超，主力共識偏多。';
    else if (foreignNet < 0 && trustNet < 0) line2 += '外資+投信同向賣超，主力撤離訊號明確。';
    else if (foreignNet * trustNet < 0) line2 += '法人態度分歧，需進一步觀察。';
    lines.push(line2);
  }

  // 3. 融資
  if (marginDelta != null) {
    const mCls = marginDelta > 0 ? 'var(--gold)' : 'var(--neon)';
    const mWord = Math.abs(marginDelta) > 5000 ? (marginDelta > 0 ? '散戶積極追價' : '散戶斷頭離場') : (marginDelta > 0 ? '散戶小幅進場' : '散戶減碼觀望');
    lines.push(`<b style="color:${mCls}">${mWord}</b> — 融資${marginDelta >= 0 ? '增加' : '減少'} <b>${Math.abs(marginDelta).toLocaleString()} 張</b>。${marginDelta < 0 && netInst > 0 ? '散戶下車、法人接手，籌碼結構轉穩。' : marginDelta > 0 && netInst < 0 ? '法人賣壓 + 散戶追高 = 警訊，留意未來幾日是否量縮拉回。' : ''}`);
  }

  // 4. 操作建議
  let advice;
  if (taiexPct >= 0.3 && netInst > 0) {
    advice = `<b style="color:var(--up)">▶ 建議：</b>偏多操作。可分批佈局法人持續買超的權值股、強勢電子族群，停損設於 10MA。<b>單檔不超過總部位 30%</b>，保留 15% 現金應對突發。`;
  } else if (taiexPct <= -0.3 && netInst < 0) {
    advice = `<b style="color:var(--down)">▶ 建議：</b>降低部位。法人賣超 + 大盤走弱，多單禁追高，建議部位降至 50% 以下。等待大盤量縮止穩、法人翻多再進場。`;
  } else if (taiexPct >= 0.3 && netInst < 0) {
    advice = `<b style="color:var(--gold)">▶ 建議：</b>慎防假突破。指數收紅但法人賣超，可能是高檔出貨。若手中有獲利部位可分批停利，新進場觀望為主。`;
  } else if (taiexPct <= -0.3 && netInst > 0) {
    advice = `<b style="color:var(--gold)">▶ 建議：</b>逢低布局訊號浮現。指數收黑但法人逆勢買超，常見於主力洗盤後吸籌。可挑法人買超且站穩 20MA 個股輕倉試水。`;
  } else {
    advice = `<b style="color:var(--gold)">▶ 建議：</b>觀望整理。市場無明確方向，建議降低交易頻率，等待量價結構確立再操作。`;
  }
  lines.push(advice);

  box.innerHTML = lines.map((l) => `<div style="margin-bottom:8px">${l}</div>`).join('');
}
