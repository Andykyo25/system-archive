// AI 智選 · 依資金預算配置
// 訂閱 ranking:updated 事件，依勝率排序與預算動態挑選與分配張數
import { state, emit, on } from '../state.js';
import { fmt } from '../utils/format.js';
import { mountChart } from './charts.js';
import { stocks as mockStocks } from '../data/mock.js';

let budgetEl, cashEl, minWinEl, rebuildBtn;
let lastRanking = [];
let allocation = [];

export function mount() {
  budgetEl = document.getElementById('ai-budget');
  cashEl   = document.getElementById('ai-cash');
  minWinEl = document.getElementById('ai-minwin');
  rebuildBtn = document.getElementById('ai-rebuild');

  rebuildBtn.addEventListener('click', () => rebuild());
  budgetEl.addEventListener('change', () => rebuild());
  cashEl.addEventListener('change', () => rebuild());
  minWinEl.addEventListener('change', () => rebuild());

  // 大盤趨勢敘述
  on('indices:changed', updateThesis);

  // ranking 更新時自動重建配置
  on('ranking:updated', (rk) => {
    lastRanking = rk || [];
    rebuild();
  });

  // placeholder
  document.getElementById('portfolio-table').innerHTML =
    `<tr><td colspan="10" style="color:var(--dim);text-align:center;padding:14px">等候排行榜資料…</td></tr>`;
}

function updateThesis() {
  const i = state.indices;
  if (!i) return;
  const taiex = i.taiex, sox = i.sox;
  const parts = [];
  if (taiex?.close != null) {
    parts.push(`TAIEX ${fmt(taiex.close, 0)} (${(taiex.pct || 0) > 0 ? '+' : ''}${(taiex.pct || 0).toFixed(2)}%)`);
  }
  if (sox?.close != null) {
    parts.push(`費半 ${fmt(sox.close, 0)} (${(sox.pct || 0) > 0 ? '+' : ''}${(sox.pct || 0).toFixed(2)}%)`);
  }
  document.getElementById('thesis-trend').textContent = parts.length
    ? `${parts.join('、')}。${(taiex?.pct || 0) > 0 ? '多頭趨勢，偏多操作。' : '量縮整理，控制部位。'}`
    : '大盤資料載入中...';
}

// ─── 核心：依預算配置 ───
function rebuild() {
  const budget = +budgetEl.value || 500000;
  const cashPct = +cashEl.value || 0;
  const minWin = +minWinEl.value || 55;

  // 可投入資金（扣現金保留）
  const investableTotal = budget * (1 - cashPct / 100);
  const cashReserved = budget - investableTotal;

  // 從 ranking 篩選：勝率 ≥ minWin 且 單張成本 ≤ 預算可投入額
  const candidates = lastRanking
    .filter((r) => r.winRate >= minWin)
    .filter((r) => r.costPerLot <= investableTotal)
    .slice(0, 10); // 最多 10 檔

  if (!candidates.length) {
    allocation = [];
    renderTable(budget, cashReserved, 0);
    document.getElementById('thesis-summary').textContent =
      `預算 ${fmt(budget, 0)} 元 / 現金保留 ${cashPct}% / 勝率 ≥ ${minWin}% — 沒有符合條件的標的。建議降低勝率門檻或增加預算。`;
    return;
  }

  // 分配權重：以「winRate - 50」為加權因子，分數越高權重越大
  const weights = candidates.map((r) => Math.max(1, r.winRate - 50));
  const totalW = weights.reduce((s, w) => s + w, 0);

  // 單檔上限：投資金額 30%
  const singleCap = investableTotal * 0.3;

  // 分配張數（整數張）
  let usedFunds = 0;
  allocation = candidates.map((r, i) => {
    const idealAmount = Math.min(singleCap, investableTotal * (weights[i] / totalW));
    let lots = Math.floor(idealAmount / r.costPerLot);
    if (lots < 1 && r.costPerLot <= investableTotal - usedFunds) lots = 1; // 至少 1 張
    const cost = lots * r.costPerLot;
    usedFunds += cost;
    return { ...r, lots, cost };
  });

  // 第二輪：剩餘資金嘗試補張數（按勝率順序）
  let remaining = investableTotal - usedFunds;
  for (const a of allocation) {
    while (remaining >= a.costPerLot && (a.cost + a.costPerLot) <= singleCap) {
      a.lots += 1;
      a.cost += a.costPerLot;
      remaining -= a.costPerLot;
    }
  }
  // 過濾 lots = 0
  allocation = allocation.filter((a) => a.lots > 0);

  const totalCost = allocation.reduce((s, a) => s + a.cost, 0);
  const finalCash = budget - totalCost;
  const finalCashPct = (finalCash / budget) * 100;

  document.getElementById('thesis-summary').innerHTML =
    `預算 <b style="color:var(--gold)">${fmt(budget, 0)}</b> 元 · 配置 <b>${allocation.length}</b> 檔 · 已投入 <b style="color:var(--up)">${fmt(totalCost, 0)}</b> · 剩餘現金 <b>${fmt(finalCash, 0)}</b> (${finalCashPct.toFixed(1)}%)`;

  renderTable(budget, finalCash, totalCost);
  drawPie(finalCash, totalCost);
}

function renderTable(budget, cash, totalCost) {
  document.getElementById('ai-count').textContent = allocation.length;
  const tbody = document.getElementById('portfolio-table');
  const tfoot = document.getElementById('portfolio-foot');

  if (!allocation.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="color:var(--dim);text-align:center;padding:14px">無符合條件的標的</td></tr>`;
    tfoot.innerHTML = '';
    return;
  }

  tbody.innerHTML = allocation.map((a) => {
    const meta = mockStocks[a.code] || {};
    const tone = a.winRate >= 65 ? 's9' : a.winRate >= 55 ? 's8' : 's7';
    const pct = (a.cost / budget) * 100;
    return `
      <tr data-code="${a.code}">
        <td>
          <div class="pf-name">${meta.name || a.code}</div>
          <div class="pf-code">${a.code} · ${meta.industry || '-'}</div>
        </td>
        <td class="pf-num">${fmt(a.close, 2)}</td>
        <td class="pf-lots">${a.lots}</td>
        <td class="pf-cost">${fmt(a.cost, 0)}</td>
        <td class="pf-weight">${pct.toFixed(1)}%</td>
        <td><span class="pf-win ${tone}">${a.winRate}%</span></td>
        <td class="pf-num">${fmt(a.entry?.low, 0)}~${fmt(a.entry?.high, 0)}</td>
        <td class="pf-num" style="color:var(--down)">${fmt(a.stop, 0)}</td>
        <td class="pf-num" style="color:var(--up)">${fmt(a.target, 0)}</td>
        <td>
          <div class="pf-reason">
            <b style="color:var(--gold)">${a.overall || '-'}</b><br>
            <span style="color:var(--neon)">${a.mainForce || ''}</span>
            ${a.signals?.length ? '<br>' + a.signals.map((s) => `<span style="color:var(--dim)">▸ ${s.text}</span>`).join('<br>') : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  tfoot.innerHTML = `
    <tr>
      <td colspan="3" style="text-align:left">合計</td>
      <td class="pf-cost">${fmt(totalCost, 0)}</td>
      <td>${((totalCost / budget) * 100).toFixed(1)}%</td>
      <td colspan="4" style="text-align:right;color:var(--dim)">剩餘現金</td>
      <td class="pf-cost" style="color:var(--gold)">${fmt(cash, 0)} (${((cash / budget) * 100).toFixed(1)}%)</td>
    </tr>
  `;

  tbody.querySelectorAll('tr[data-code]').forEach((tr) => {
    tr.addEventListener('click', () => {
      emit('select', tr.dataset.code);
      document.getElementById('stock-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function drawPie(cash, totalCost) {
  const data = [
    ...allocation.map((a) => ({ name: (mockStocks[a.code]?.name || a.code), v: a.cost })),
    { name: '現金', v: cash },
  ];
  mountChart('chartPortfolio', {
    type: 'doughnut',
    data: {
      labels: data.map((d) => `${d.name} (${fmt(d.v, 0)})`),
      datasets: [{
        data: data.map((d) => d.v),
        backgroundColor: [
          '#ff3b4e', '#ff6478', '#ff8a9b', '#ffb0bd', '#ffd0d8',
          '#7a5cff', '#9d85ff', '#bfaeff', '#d9c8ff', '#e8dcff',
          '#3a4252',
        ],
        borderColor: '#0c1118', borderWidth: 2,
      }],
    },
    options: {
      plugins: {
        legend: { position: 'right', labels: { color: '#c9d1de', font: { size: 11 }, boxWidth: 12, padding: 6 } },
        title: { display: true, text: '資金配置', color: '#f6c452', font: { size: 13, weight: 'bold' } },
      },
      maintainAspectRatio: false, cutout: '55%', animation: false,
    },
  });
}
