// 我的持股 + 每日報告 + 每週復盤
import { api } from '../data/api.js';
import { fmt, sign } from '../utils/format.js';
import { state, emit } from '../state.js';

let formEl, tbodyEl, reportEl;
let activeReport = 'daily';

export function mount() {
  formEl = document.getElementById('holding-form');
  tbodyEl = document.getElementById('holdings-tbody');
  reportEl = document.getElementById('report-area');

  // 預設今日日期
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('hf-date').value = today;

  // 表單提交：新增持股
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      code: document.getElementById('hf-code').value.trim(),
      entry_date: document.getElementById('hf-date').value,
      entry_price: +document.getElementById('hf-price').value,
      lots: +document.getElementById('hf-lots').value || 1,
      note: document.getElementById('hf-note').value.trim() || null,
    };
    if (!body.code || !body.entry_date || !body.entry_price) {
      alert('請填代號、日期、價格');
      return;
    }
    try {
      await api.portfolioAdd(body);
      formEl.reset();
      document.getElementById('hf-date').value = today;
      await refresh();
    } catch (err) {
      alert('新增失敗：' + err.message);
    }
  });

  // 報告 tab 切換
  document.querySelectorAll('.report-tabs .tab[data-rep]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.report-tabs .tab[data-rep]').forEach((x) => x.classList.remove('active'));
      btn.classList.add('active');
      activeReport = btn.dataset.rep;
      loadReport();
    });
  });

  refresh();
  // 持股列表每 60 秒重整
  setInterval(refresh, 60000);
}

async function refresh() {
  await Promise.all([loadHoldings(), loadReport()]);
}

async function loadHoldings() {
  try {
    const all = await api.portfolioList();
    const active = (all || []).filter((h) => h.status === 'active');
    if (!active.length) {
      tbodyEl.innerHTML = `<tr><td colspan="9" class="holdings-empty">尚無持股 — 用上方表單輸入買進記錄</td></tr>`;
      return;
    }
    tbodyEl.innerHTML = active.map((h) => {
      const pl = h.pl_pct;
      const plCls = pl == null ? '' : pl > 0 ? 'pl-up' : pl < 0 ? 'pl-down' : '';
      const advice = h.advice || 'hold';
      const adviceMap = {
        hold:        ['持有觀察', 'signal-hold'],
        add:         ['可加碼', 'signal-buy'],
        sell:        ['建議出場', 'signal-sell'],
        take_profit: ['可停利', 'signal-buy'],
        reduce:      ['降低部位', 'signal-sell'],
      };
      const [adviceText, adviceCls] = adviceMap[advice] || ['—', ''];
      const winColor = h.win_rate == null ? 'var(--dim)' : h.win_rate >= 60 ? 'var(--up)' : h.win_rate >= 45 ? 'var(--gold)' : 'var(--down)';
      return `
        <tr data-code="${h.code}" data-id="${h.id}">
          <td style="text-align:left">
            <b>${h.code}</b> ${h.name || ''}
            ${h.note ? `<div style="color:var(--dim);font-size:10px">${h.note}</div>` : ''}
          </td>
          <td>${h.entry_date}</td>
          <td>${fmt(h.entry_price, 2)}</td>
          <td>${h.lots}</td>
          <td>${h.current_price != null ? fmt(h.current_price, 2) : '--'}</td>
          <td class="${plCls}">${pl != null ? (pl > 0 ? '+' : '') + pl.toFixed(2) + '%' : '--'}
            ${h.pl != null ? `<div style="font-size:10px;color:var(--dim)">${h.pl >= 0 ? '+' : ''}${Math.round(h.pl).toLocaleString()} 元</div>` : ''}
          </td>
          <td><span style="color:${winColor};font-weight:700">${h.win_rate != null ? h.win_rate + '%' : '--'}</span></td>
          <td style="text-align:left" class="${adviceCls}">${adviceText}
            ${h.stop ? `<div style="font-size:10px;color:var(--dim)">停損 ${h.stop} / 停利 ${h.target1 || '--'}</div>` : ''}
          </td>
          <td>
            <button class="act-btn act-close" data-id="${h.id}" data-code="${h.code}" data-price="${h.current_price ?? ''}">平倉</button>
            <button class="act-btn act-del" data-id="${h.id}">刪除</button>
          </td>
        </tr>
      `;
    }).join('');

    // 點擊代號跳轉至個股面板
    tbodyEl.querySelectorAll('tr[data-code]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.classList.contains('act-btn')) return;
        emit('select', tr.dataset.code);
        document.getElementById('stock-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    // 平倉
    tbodyEl.querySelectorAll('.act-close').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = +btn.dataset.id;
        const suggested = btn.dataset.price || '';
        const exitPrice = prompt(`${btn.dataset.code} 平倉價？（建議 ${suggested}）`, suggested);
        if (!exitPrice) return;
        try {
          await api.portfolioClose(id, { exit_price: +exitPrice });
          await refresh();
        } catch (err) {
          alert('平倉失敗：' + err.message);
        }
      });
    });
    // 刪除
    tbodyEl.querySelectorAll('.act-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('確定刪除這筆記錄？')) return;
        try {
          await api.portfolioDelete(+btn.dataset.id);
          await refresh();
        } catch (err) {
          alert('刪除失敗：' + err.message);
        }
      });
    });
  } catch (err) {
    tbodyEl.innerHTML = `<tr><td colspan="9" class="holdings-empty">載入失敗：${err.message}</td></tr>`;
  }
}

async function loadReport() {
  try {
    if (activeReport === 'daily') {
      const r = await api.reportDaily();
      renderDailyReport(r);
    } else {
      const r = await api.reportWeekly();
      renderWeeklyReport(r);
    }
  } catch (err) {
    reportEl.innerHTML = `<div class="report-section" style="color:var(--down)">載入報告失敗：${err.message}</div>`;
  }
}

function renderDailyReport(r) {
  if (!r.holdings || !r.items?.length) {
    reportEl.innerHTML = `<div class="report-section">${r.message || '無持股，暫無報告'}</div>`;
    return;
  }
  const sum = r.summary || {};
  const totalCls = sum.totalPL > 0 ? 'pl-up' : sum.totalPL < 0 ? 'pl-down' : '';
  const lines = [];
  lines.push(`<h3>📋 今日盤點 · ${r.date}</h3>`);
  lines.push(`<div class="report-line">
    持股 <b>${r.holdings}</b> 檔 ·
    本日合計損益 <b class="${totalCls}">${sum.totalPL >= 0 ? '+' : ''}${sum.totalPL?.toLocaleString()} 元</b> ·
    獲利股 ${sum.winners}／虧損股 ${sum.losers}（勝率 ${sum.winRate}%）
  </div>`);
  r.items.forEach((it) => {
    if (it.error) {
      lines.push(`<div class="report-line">${it.code}：${it.error}</div>`);
      return;
    }
    const cls = it.plPct > 0 ? 'pl-up' : it.plPct < 0 ? 'pl-down' : '';
    lines.push(`<div class="report-line" style="white-space:pre-wrap;font-family:'Inter','Noto Sans TC',monospace">${it.text.replace(it.code, `<b>${it.code}</b>`).replace(/\n/g, '<br>')}</div>`);
  });
  reportEl.innerHTML = `<div class="report-section">${lines.join('')}</div>`;
}

function renderWeeklyReport(r) {
  const lines = [];
  lines.push(`<h3>📊 本週復盤 · ${r.weekStart} → ${r.weekEnd}</h3>`);
  lines.push(`<div class="report-line">
    本週新進場 <b>${r.newPositions}</b> 檔 / 平倉 <b>${r.closedPositions}</b> 檔 / 持有 <b>${r.activePositions}</b> 檔
  </div>`);
  if (r.realizedPL != null) {
    const cls = r.realizedPL > 0 ? 'pl-up' : 'pl-down';
    lines.push(`<div class="report-line">
      本週已實現損益：<b class="${cls}">${r.realizedPL >= 0 ? '+' : ''}${r.realizedPL.toLocaleString()} 元</b>
      （${r.closedWinners} 檔獲利出場）
    </div>`);
  }
  if (r.taiexWeekPct != null) {
    const cls = r.taiexWeekPct > 0 ? 'pl-up' : 'pl-down';
    lines.push(`<div class="report-line">大盤本週：<b class="${cls}">${r.taiexWeekPct >= 0 ? '+' : ''}${r.taiexWeekPct}%</b></div>`);
  }
  if (r.best?.length) {
    lines.push(`<div class="report-line"><b style="color:var(--up)">▲ 本週最佳表現：</b>${r.best.map((b) => `${b.code}${b.name ? ' ' + b.name : ''} ${b.plPct >= 0 ? '+' : ''}${b.plPct.toFixed(2)}%`).join('、')}</div>`);
  }
  if (r.worst?.length) {
    lines.push(`<div class="report-line"><b style="color:var(--down)">▼ 本週最差表現：</b>${r.worst.map((b) => `${b.code}${b.name ? ' ' + b.name : ''} ${b.plPct >= 0 ? '+' : ''}${b.plPct.toFixed(2)}%`).join('、')}</div>`);
  }
  if (r.newThisWeek?.length) {
    lines.push(`<div class="report-line">本週新進：${r.newThisWeek.map((h) => `${h.code} @${h.entry_price}`).join('、')}</div>`);
  }
  if (r.closedThisWeek?.length) {
    lines.push(`<div class="report-line">本週平倉：${r.closedThisWeek.map((h) => {
      const pl = h.exit_price && h.entry_price ? ((h.exit_price - h.entry_price) / h.entry_price * 100).toFixed(2) : '--';
      return `${h.code} ${pl}%`;
    }).join('、')}</div>`);
  }
  reportEl.innerHTML = `<div class="report-section">${lines.join('')}</div>`;
}
