// AI 智選 · 依資金預算配置
// 訂閱 ranking:updated 事件，依勝率排序與預算動態挑選與分配張數
import { state, emit, on } from '../state.js';
import { fmt } from '../utils/format.js';
import { mountChart } from './charts.js';
import { stocks as mockStocks } from '../data/mock.js';
import { api } from '../data/api.js';

let budgetEl, cashEl, minWinEl, rebuildBtn;
let lastRanking = [];
let allocation = [];
let activeHoldings = [];   // 目前持股快照
let usedCapital = 0;       // 持股已佔用資金
let universeMeta = { core: 0, holdings: 0, hot: 0, total: 0 };

export function mount() {
  budgetEl = document.getElementById('ai-budget');
  cashEl   = document.getElementById('ai-cash');
  minWinEl = document.getElementById('ai-minwin');
  rebuildBtn = document.getElementById('ai-rebuild');

  rebuildBtn.addEventListener('click', () => {
    // 顯示 loading 狀態 + 觸發 ranking 重抓（ranking 完成後會 emit ranking:updated → 自動 rebuild）
    document.getElementById('thesis-summary').innerHTML =
      '<span style="color:var(--gold)">📊 正在掃描候選股…（並發 3、預計 30-60 秒）</span>';
    emit('ranking:reload');
  });
  budgetEl.addEventListener('change', () => rebuild());
  cashEl.addEventListener('change', () => rebuild());
  minWinEl.addEventListener('change', () => rebuild());

  // 大盤趨勢敘述
  on('indices:changed', updateThesis);

  // ranking 更新時自動重建配置（新格式: { result, meta }；舊格式 fallback）
  on('ranking:updated', (payload) => {
    if (payload && Array.isArray(payload.result)) {
      lastRanking = payload.result;
      universeMeta = payload.meta || universeMeta;
    } else {
      lastRanking = payload || [];
    }
    rebuild();
  });

  // 持股新增 / 刪除 / 平倉 → 重新讀持股 + 重建配置
  on('holdings:changed', () => {
    refreshHoldings().then(() => rebuild());
  });

  // 啟動時先載一次持股
  refreshHoldings();

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

// 從 server 拉持股
async function refreshHoldings() {
  try {
    const all = await api.portfolioList();
    activeHoldings = (all || []).filter((h) => h.status === 'active');
    usedCapital = activeHoldings.reduce((s, h) => s + (h.entry_price * h.lots * 1000), 0);
  } catch {
    activeHoldings = [];
    usedCapital = 0;
  }
}

// ─── 核心：依預算配置（已扣除持股佔用資金、排除已持有股）───
function rebuild() {
  // ★ ranking 還沒拿到 → 顯示 loading，不要急著 fail（避免「0 檔」誤導）
  if (!lastRanking.length) {
    allocation = [];
    renderTable(+budgetEl.value || 250000, 0, 0);
    document.getElementById('thesis-summary').innerHTML =
      '<span style="color:var(--gold)">📊 候選股掃描中…</span>（首次或剛重啟需 30-60 秒，掃完會自動配置）';
    return;
  }

  const budget = +budgetEl.value || 250000;
  const cashPct = +cashEl.value || 0;
  const minWin = +minWinEl.value || 55;

  // 可投入資金 = 預算 - 持股佔用 - 現金保留
  const totalAfterCash = budget * (1 - cashPct / 100);
  const investableTotal = Math.max(0, totalAfterCash - usedCapital);
  const cashReserved = budget - totalAfterCash;
  const heldCodes = new Set(activeHoldings.map((h) => h.code));

  // 篩選邏輯：
  //   strict：勝率 ≥ minWin、EV ≥ -1（明顯正期望值或接近 break-even）
  //   relax：strict 0 檔時自動放寬到 EV ≥ -2，並提示
  const baseFilter = (r) =>
    r.winRate >= minWin
    && r.costPerLot <= investableTotal
    && !heldCodes.has(r.code);
  let relaxed = false;
  let candidates = lastRanking
    .filter(baseFilter)
    .filter((r) => (r.expectedValue?.target1 ?? 0) >= -1)
    .slice(0, 10);

  // Auto-relax：EV 條件自動放寬一階（避免在熊市時直接 0 檔）
  if (!candidates.length) {
    relaxed = true;
    candidates = lastRanking
      .filter(baseFilter)
      .filter((r) => (r.expectedValue?.target1 ?? 0) >= -2)
      .slice(0, 10);
  }

  if (!candidates.length) {
    allocation = [];
    renderTable(budget, cashReserved, 0);
    // 找出 ranking 全部結果中為何被刷掉，給具體建議
    const total = lastRanking.length;
    const passWin = lastRanking.filter((r) => r.winRate >= minWin).length;
    const passBudget = lastRanking.filter((r) => r.costPerLot <= investableTotal).length;
    const passEV = lastRanking.filter((r) => (r.expectedValue?.target1 ?? 0) >= -2).length;
    let suggestion = '';
    if (investableTotal <= 0) {
      suggestion = `<span style="color:var(--gold)">⚠ 可投入資金已耗盡</span>。預算 ${fmt(budget, 0)} − 持股佔用 ${fmt(usedCapital, 0)} − 現金保留 ${cashPct}% = 0`;
    } else if (passWin === 0) {
      suggestion = `<span style="color:var(--gold)">⚠ 沒有股票勝率達 ${minWin}%</span>（最高 ${Math.max(...lastRanking.map((r) => r.winRate))}%）。建議把「最低勝率」調到 50% 試試`;
    } else if (passEV === 0) {
      suggestion = `<span style="color:var(--gold)">⚠ 沒有股票 EV ≥ -2%</span>（賠率太差）。可能大盤偏空、目標獲利空間有限。建議改觀望或加大現金保留`;
    } else if (passBudget === 0) {
      suggestion = `<span style="color:var(--gold)">⚠ 預算太少</span>，所有候選股單張成本都超過 ${fmt(investableTotal, 0)}。建議加大資金總額或降低現金保留`;
    } else {
      suggestion = `候選股都被個別條件刷掉。掃描 ${total} 檔 / 過勝率 ${passWin} / 過 EV ${passEV} / 過預算 ${passBudget}`;
    }
    document.getElementById('thesis-summary').innerHTML = suggestion;
    return;
  }
  // strict 沒過、relax 才過 → 在 thesis-summary 顯示「自動放寬」提示
  if (relaxed) {
    setTimeout(() => {
      const el = document.getElementById('thesis-summary');
      if (el) el.innerHTML = `<span style="color:var(--gold)">⚠ 已自動放寬條件（EV ≥ -2）</span> — 嚴格 EV 標準下沒有符合的標的，目前推薦的 ${candidates.length} 檔屬於「中性偏負期望」，建議降低部位<br>` + el.innerHTML;
    }, 0);
  }

  // 分配權重：以「winRate - 50」為加權因子，分數越高權重越大
  // ★ 權重融合：EV 為主（盈虧比加權勝率，更接近真實獲利期望）+ 勝率作 baseline
  const weights = candidates.map((r) => {
    const ev = r.expectedValue?.target1 ?? 0;
    const winBase = Math.max(0, r.winRate - 50);
    return Math.max(1, ev * 5 + winBase);   // EV 每 +1% 約等於 winRate +5
  });
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

  // universe 來源摘要（核心 + 持股 + 熱錢三層）
  const m = universeMeta;
  const universeStr = m.total
    ? `<span style="color:var(--dim);font-size:11px">候選池 ${m.total} 檔（核心 ${m.core}+ 持股 ${m.holdings}+ 熱錢 ${m.hot}）</span>`
    : '';
  document.getElementById('thesis-summary').innerHTML =
    `預算 <b style="color:var(--gold)">${fmt(budget, 0)}</b>` +
    (usedCapital > 0 ? ` · 持股佔用 <b style="color:var(--neon)">${fmt(usedCapital, 0)}</b>（${activeHoldings.length} 檔已排除）` : '') +
    ` · 新配置 <b>${allocation.length}</b> 檔 / <b style="color:var(--up)">${fmt(totalCost, 0)}</b>` +
    ` · 剩餘現金 <b>${fmt(finalCash, 0)}</b> (${finalCashPct.toFixed(1)}%)` +
    (universeStr ? '<br>' + universeStr : '');

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
        <td>
          <span class="pf-win ${tone}">${a.winRate}%</span>
          ${a.expectedValue?.target1 != null ? `<div style="font-size:10px;color:${a.expectedValue.target1 >= 1 ? 'var(--up)' : a.expectedValue.target1 >= 0 ? 'var(--gold)' : 'var(--down)'}">EV ${a.expectedValue.target1 >= 0 ? '+' : ''}${a.expectedValue.target1}%</div>` : ''}
        </td>
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
