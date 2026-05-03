// Backtest 結果面板 + Ablation Study
import { api } from '../data/api.js';
import { mountChart, theme } from './charts.js';
import { fmt } from '../utils/format.js';

const VARIANT_LABELS = {
  baseline:      ['Buy-and-Hold', '#7d8aa0'],
  legacy:        ['升級前', '#aab2c0'],
  current:       ['目前完整版', '#f6c452'],
  'no-industry': ['關掉產業 RS', '#ff7a1a'],
  'no-regime':   ['關掉大盤 regime', '#7a5cff'],
};

export function mount() {
  document.getElementById('bt-run').addEventListener('click', runBacktest);
  // 啟動時先看有沒有 cached 結果
  loadLatest();
}

async function loadLatest() {
  try {
    const r = await api.backtestLatest();
    if (r.status === 'no_data') {
      setStatus('尚未執行 — 點「▶ 跑 Backtest」一次（過程約 1-2 分鐘）');
      return;
    }
    render(r);
  } catch (e) {
    setStatus(`載入失敗：${e.message}`);
  }
}

async function runBacktest() {
  const btn = document.getElementById('bt-run');
  btn.disabled = true;
  btn.textContent = '計算中…請稍候';
  setStatus('正在拉歷史資料、模擬 5 路線交易，預計 60-120 秒…');
  try {
    const t0 = Date.now();
    const r = await api.backtestRun();
    const ms = Date.now() - t0;
    setStatus(`完成 · ${ms} ms · 涵蓋 ${r.universe} 檔 · 過去 ${r.lookbackDays} 天`);
    render(r);
  } catch (e) {
    setStatus(`失敗：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ 重跑 Backtest';
  }
}

function setStatus(msg) {
  document.getElementById('bt-status').textContent = msg;
}

function render(r) {
  const results = r.results || {};
  const order = ['baseline', 'legacy', 'current', 'no-industry', 'no-regime'];

  // 表格
  const tbody = document.getElementById('bt-tbody');
  tbody.innerHTML = order.map((v) => {
    const d = results[v];
    if (!d) return '';
    const [label, color] = VARIANT_LABELS[v];
    const cumColor = d.cumulativeReturn > 0 ? 'var(--up)' : 'var(--down)';
    const sharpeColor = d.sharpe > 1 ? 'var(--up)' : d.sharpe > 0 ? 'var(--gold)' : 'var(--down)';
    const winColor = d.winRate >= 55 ? 'var(--up)' : d.winRate >= 50 ? 'var(--gold)' : 'var(--down)';
    return `<tr ${v === 'current' ? 'style="background:rgba(246,196,82,.08)"' : ''}>
      <td style="text-align:left"><span style="display:inline-block;width:10px;height:10px;background:${color};border-radius:2px;margin-right:6px"></span><b>${label}</b>${v === 'current' ? ' ⭐' : ''}</td>
      <td>${d.trades}</td>
      <td style="color:${winColor}">${d.winRate}%</td>
      <td style="color:${cumColor};font-weight:700">${d.cumulativeReturn >= 0 ? '+' : ''}${d.cumulativeReturn}%</td>
      <td>${d.avgReturn >= 0 ? '+' : ''}${d.avgReturn}%</td>
      <td style="color:${sharpeColor};font-weight:700">${d.sharpe}</td>
      <td style="color:var(--down)">${d.maxDrawdown}%</td>
    </tr>`;
  }).join('');
  document.getElementById('bt-table').style.display = '';

  // 圖表
  document.getElementById('bt-chart-wrap').style.display = '';
  drawChart(results, order);

  // 結論文字
  document.getElementById('bt-conclusion').style.display = '';
  document.getElementById('bt-conclusion').innerHTML = buildConclusion(results);
}

function drawChart(results, order) {
  // 收集所有 unique dates 為 x 軸
  const dateSet = new Set();
  order.forEach((v) => (results[v]?.equity || []).forEach((e) => dateSet.add(e.date)));
  const labels = [...dateSet].sort();

  const datasets = order.map((v) => {
    const d = results[v];
    if (!d) return null;
    const [label, color] = VARIANT_LABELS[v];
    // map equity by date
    const map = new Map((d.equity || []).map((e) => [e.date, e.eq]));
    let last = 1;
    const data = labels.map((dt) => {
      if (map.has(dt)) last = map.get(dt);
      return +((last - 1) * 100).toFixed(2);
    });
    return {
      label, data,
      borderColor: color,
      borderWidth: v === 'current' ? 2 : 1.2,
      pointRadius: 0, tension: 0.15,
    };
  }).filter(Boolean);

  mountChart('bt-chart', {
    type: 'line',
    data: { labels, datasets },
    options: {
      plugins: {
        legend: { labels: { color: '#aab2c0', font: { size: 11 } } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: { ticks: { ...theme.axis, maxTicksLimit: 10 }, grid: theme.grid },
        y: { ticks: { ...theme.axis, callback: (v) => v + '%' }, grid: theme.grid },
      },
      maintainAspectRatio: false, animation: false,
    },
  });
}

function buildConclusion(results) {
  const cur = results.current;
  const legacy = results.legacy;
  const baseline = results.baseline;
  if (!cur || !legacy) return '';

  const lines = [];
  // 1. 整體系統效能 vs Baseline
  const vsBaseline = cur.cumulativeReturn - baseline.cumulativeReturn;
  if (vsBaseline > 5) {
    lines.push(`<div style="color:var(--up)">✓ <b>系統勝過 Buy-and-Hold</b>：累積報酬 ${cur.cumulativeReturn >= 0 ? '+' : ''}${cur.cumulativeReturn}% vs ${baseline.cumulativeReturn >= 0 ? '+' : ''}${baseline.cumulativeReturn}%（超額 ${vsBaseline >= 0 ? '+' : ''}${vsBaseline.toFixed(1)}%）</div>`);
  } else if (vsBaseline < -5) {
    lines.push(`<div style="color:var(--down)">✗ <b>系統輸給 Buy-and-Hold</b>：累積報酬 ${cur.cumulativeReturn >= 0 ? '+' : ''}${cur.cumulativeReturn}% vs ${baseline.cumulativeReturn >= 0 ? '+' : ''}${baseline.cumulativeReturn}% — 系統訊號可能在傷害績效</div>`);
  } else {
    lines.push(`<div style="color:var(--gold)">⚪ 系統與 Buy-and-Hold 相當（差距 ${vsBaseline.toFixed(1)}%）— 訊號帶來的 alpha 還不明顯</div>`);
  }

  // 2. Feature 升級的真實貢獻
  const feDelta = cur.cumulativeReturn - legacy.cumulativeReturn;
  const sharpeDelta = cur.sharpe - legacy.sharpe;
  if (feDelta > 3 || sharpeDelta > 0.2) {
    lines.push(`<div style="color:var(--up)">✓ <b>Feature 升級有效</b>：累積報酬 +${feDelta.toFixed(1)}%、Sharpe ${sharpeDelta >= 0 ? '+' : ''}${sharpeDelta.toFixed(2)}</div>`);
  } else if (feDelta < -3) {
    lines.push(`<div style="color:var(--down)">✗ <b>Feature 升級反而傷害績效</b>：累積報酬 ${feDelta.toFixed(1)}%、Sharpe ${sharpeDelta.toFixed(2)} — 應該檢查哪個 feature 在誤判</div>`);
  } else {
    lines.push(`<div style="color:var(--gold)">⚪ Feature 升級貢獻邊際（${feDelta.toFixed(1)}%）</div>`);
  }

  // 3. Ablation：產業 RS 與 regime 的個別貢獻
  const noInd = results['no-industry'];
  const noReg = results['no-regime'];
  if (noInd) {
    const indContrib = cur.cumulativeReturn - noInd.cumulativeReturn;
    const tone = indContrib > 1 ? 'var(--up)' : indContrib < -1 ? 'var(--down)' : 'var(--dim)';
    lines.push(`<div style="color:${tone}">  · 產業 RS 個別貢獻：${indContrib >= 0 ? '+' : ''}${indContrib.toFixed(1)}% 累積報酬</div>`);
  }
  if (noReg) {
    const regContrib = cur.cumulativeReturn - noReg.cumulativeReturn;
    const tone = regContrib > 1 ? 'var(--up)' : regContrib < -1 ? 'var(--down)' : 'var(--dim)';
    lines.push(`<div style="color:${tone}">  · 大盤 regime 個別貢獻：${regContrib >= 0 ? '+' : ''}${regContrib.toFixed(1)}% 累積報酬</div>`);
  }

  // 4. Sharpe 解讀
  if (cur.sharpe > 1.5) lines.push(`<div style="color:var(--up)">✓ Sharpe ${cur.sharpe} — 風險調整後表現優異（>1.5 為佳）</div>`);
  else if (cur.sharpe > 1) lines.push(`<div style="color:var(--gold)">⚪ Sharpe ${cur.sharpe} — 表現可接受但不算強勢</div>`);
  else if (cur.sharpe > 0) lines.push(`<div style="color:var(--down)">✗ Sharpe ${cur.sharpe} — 賺得不夠補償波動，需檢討</div>`);
  else lines.push(`<div style="color:var(--down)">✗ Sharpe 負值 — 系統可能負 EV，建議大改</div>`);

  // 5. 最大回撤
  if (cur.maxDrawdown < -25) lines.push(`<div style="color:var(--down)">⚠ 最大回撤 ${cur.maxDrawdown}% — 風控不足，需檢視停損紀律</div>`);

  return lines.join('');
}
