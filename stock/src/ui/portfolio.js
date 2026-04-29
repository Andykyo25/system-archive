import { state, emit, on } from '../state.js';
import { fmt } from '../utils/format.js';
import { portfolio } from '../data/mock.js';
import { mountChart } from './charts.js';
import { api } from '../data/api.js';
import { diagnose } from '../utils/diagnose.js';

// 八檔持股的動態評估快取（重整或盤中重新計算）
let evaluations = [];
let mounted = false;

export function mount() {
  mounted = true;
  // 圓餅靜態（依 weight）
  drawPie();

  // 大盤趨勢敘述監聽
  on('indices:changed', () => {
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
      ? `${parts.join('、')}。${(taiex?.pct || 0) > 0 ? '多方續攻，符合方案 B 進場前提。' : '量縮整理，方案 B 暫緩進場、保留現金等待回測。'}`
      : '大盤資料載入中...';
  });
  document.getElementById('thesis-theme').innerHTML =
    '<b style="color:var(--gold)">AI 伺服器</b>、<b style="color:var(--gold)">低軌衛星</b>、<b style="color:var(--gold)">AI 散熱</b>、<b style="color:var(--gold)">機器人</b>四主軸；避開航運、面板、塑化等空頭族群。';

  // 顯示佔位，避免空白
  renderLoading();

  // 啟動後評估，並每 3 分鐘重評估一次（盤中）
  evaluate();
  setInterval(() => {
    if (state.session === 'live' || state.session === 'pre') evaluate();
  }, 180 * 1000);
}

function renderLoading() {
  const tbody = document.getElementById('portfolio-table');
  if (!tbody) return;
  tbody.innerHTML = portfolio.map((p) => {
    const s = state.stocks[p.code] || { name: p.code, industry: '-' };
    return `<tr>
      <td>
        <div class="pf-name">${s.name}</div>
        <div class="pf-code">${p.code} · ${s.industry || '-'}</div>
      </td>
      <td><span class="pf-plan ${p.plan}">${p.plan === 'B' ? '方案 B' : '方案 A'}</span></td>
      <td><span class="pf-weight">${p.weight}%</span></td>
      <td colspan="6" style="color:var(--dim);text-align:left">即時評估中…</td>
    </tr>`;
  }).join('');
}

// 對 portfolio 8 檔並行抓 K 線 + 三大法人 + 流通股數 + 財報 → diagnose → 動態算 entry/stop/target/win
async function evaluate() {
  const tasks = portfolio.map(async (p) => {
    try {
      const [klineRaw, instRaw, shInfo, finRaw, revRaw] = await Promise.all([
        api.kline(p.code, 90),
        api.institutional(p.code).catch(() => []),
        api.shareholding(p.code).catch(() => null),
        api.financial(p.code).catch(() => []),
        api.revenue(p.code).catch(() => []),
      ]);
      const k = (klineRaw || []).map((r) => ({
        open: +r.open,
        high: +(r.max ?? r.high),
        low: +(r.min ?? r.low),
        close: +r.close,
        vol: +(r.Trading_Volume ?? r.volume ?? 0),
        date: r.date,
      })).filter((d) => Number.isFinite(d.close));
      if (k.length < 5) return { ...p, error: 'no kline' };
      const sharesOutstanding = shInfo?.sharesOutstanding || null;
      const d = diagnose(k, instRaw, { sharesOutstanding });
      const close = k[k.length - 1].close;

      // ATR 動態 entry/stop/target（風報比 1.5）
      const atr = d?.atr14 || close * 0.025; // fallback 2.5% 約等於台股中型股 ATR
      const entryLow  = Math.round((close - atr * 0.5) * 100) / 100;
      const entryHigh = Math.round((close + atr * 0.5) * 100) / 100;
      const stop      = Math.round(close - 2 * atr);
      const target    = Math.round(close + 3 * atr);

      // Bias > 10 → win 強制 -3
      let win = Math.max(5, Math.min(10, Math.round((d?.winRate || 50) / 10)));
      let reasonExtra = '';
      if (d?.bias20 != null && d.bias20 > 10) {
        win = Math.max(1, win - 3);
        reasonExtra = ` ⚠ Bias20 +${d.bias20.toFixed(1)}%，乖離過大避免追高`;
      }

      const rate = scoreToGrades(d, { financial: finRaw, revenue: revRaw });
      return {
        ...p,
        close,
        entry: `${fmt(entryLow, 0)} ~ ${fmt(entryHigh, 0)}`,
        stop,
        target,
        win,
        rate,
        diagnoseSnapshot: d,
        reason: p.reason + reasonExtra,
      };
    } catch (e) {
      return { ...p, error: e.message };
    }
  });
  evaluations = await Promise.all(tasks);
  if (mounted) renderTable();
}

// 從 FinMind 財報抽 EPS YoY 與 毛利率 YoY
function extractFundYoY(financial = [], revenue = []) {
  // EPS YoY：取最近兩個年度（或近 4 季 vs 前 4 季）
  const epsRows = (financial || []).filter((r) => r.type === 'EPS' || r.type === 'BasicEPS')
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let epsYoY = null;
  if (epsRows.length >= 2) {
    const latest = +epsRows[epsRows.length - 1].value;
    const prev = +epsRows[epsRows.length - 2].value;
    if (Number.isFinite(latest) && Number.isFinite(prev) && prev !== 0) {
      epsYoY = ((latest - prev) / Math.abs(prev)) * 100;
    }
  }
  // 毛利率 YoY：FinMind type 含 GrossProfit / Revenue → 比較
  const grossNow = (financial || []).filter((r) => r.type === 'GrossProfit').slice(-1)[0];
  const grossPrev = (financial || []).filter((r) => r.type === 'GrossProfit').slice(-2, -1)[0];
  const revNow = (financial || []).filter((r) => r.type === 'Revenue' || r.type === 'OperatingRevenue').slice(-1)[0];
  const revPrev = (financial || []).filter((r) => r.type === 'Revenue' || r.type === 'OperatingRevenue').slice(-2, -1)[0];
  let gpmYoY = null;
  if (grossNow && grossPrev && revNow && revPrev) {
    const gpmN = (+grossNow.value) / (+revNow.value || 1) * 100;
    const gpmP = (+grossPrev.value) / (+revPrev.value || 1) * 100;
    if (Number.isFinite(gpmN) && Number.isFinite(gpmP)) gpmYoY = gpmN - gpmP;
  }
  // 月營收 YoY：fallback 用 revenue（每月一筆）取最近 12M vs 前 12M
  let revYoY = null;
  if (Array.isArray(revenue) && revenue.length >= 24) {
    const recent = revenue.slice(-12).reduce((s, r) => s + (+r.revenue || 0), 0);
    const prior = revenue.slice(-24, -12).reduce((s, r) => s + (+r.revenue || 0), 0);
    if (prior > 0) revYoY = ((recent - prior) / prior) * 100;
  }
  return { epsYoY, gpmYoY, revYoY };
}

// 把 diagnose + 真實財報 轉成基/籌/技/消 四面評等
function scoreToGrades(d, ctx = {}) {
  if (!d) return { 基本:'C', 籌碼:'C', 技術:'C', 消息:'C' };

  // 基本面：真實 EPS YoY + 毛利率 YoY（不再使用 d.score）
  const { epsYoY, gpmYoY, revYoY } = extractFundYoY(ctx.financial || [], ctx.revenue || []);
  let fundPts = 0;
  if (epsYoY != null) {
    if (epsYoY > 30) fundPts += 2;
    else if (epsYoY > 10) fundPts += 1;
    else if (epsYoY < -10) fundPts -= 1;
  } else if (revYoY != null) {
    // 沒 EPS → 用月營收 YoY 替代
    if (revYoY > 20) fundPts += 2;
    else if (revYoY > 5) fundPts += 1;
    else if (revYoY < -5) fundPts -= 1;
  }
  if (gpmYoY != null && gpmYoY > 0) fundPts += 1;
  else if (gpmYoY != null && gpmYoY < -2) fundPts -= 1;
  const fund = fundPts >= 2 ? 'A' : fundPts >= 1 ? 'B' : fundPts >= 0 ? 'C' : 'D';

  // 籌碼面：投信佔股本比閾值
  const tp = d.inst?.trustPctOfCap;
  const inst = tp != null
    ? (tp > 0.5 ? 'A' : tp > 0.2 ? 'B' : tp > 0 ? 'C' : 'D')
    : (d.inst.total > 1000000 ? 'A' : d.inst.total > 0 ? 'B' : 'C'); // fallback：原本的張數法

  // 技術面：MA + KD + MACD（保留原邏輯）
  const techPts = (d.trend.includes('多頭') ? 2 : d.trend.includes('偏多') ? 1 : 0)
    + (d.kd.signal === '黃金交叉' || d.kd.signal === '多頭排列' ? 1 : 0)
    + (d.macd.signal.startsWith('多頭') ? 1 : 0);
  const tech = techPts >= 3 ? 'A' : techPts >= 2 ? 'B' : 'C';

  // 消息面：訊號中是否有「機會」標籤
  const news = d.signals.some((s) => s.tag === '機會') ? 'A'
    : d.signals.some((s) => s.tag === '警示') ? 'C' : 'B';
  return { 基本: fund, 籌碼: inst, 技術: tech, 消息: news };
}

function renderTable() {
  const tbody = document.getElementById('portfolio-table');
  if (!tbody) return;
  tbody.innerHTML = evaluations.map((p) => {
    const s = state.stocks[p.code] || { name: p.code, industry: '-' };
    const tone = p.win >= 9 ? 's9' : p.win >= 8 ? 's8' : 's7';
    const stockClose = state.stocks[p.code]?.price ?? p.close;
    const upPct = stockClose && p.target ? (((p.target - stockClose) / stockClose) * 100).toFixed(0) : '-';
    if (p.error) {
      return `<tr data-code="${p.code}">
        <td>
          <div class="pf-name">${s.name}</div>
          <div class="pf-code">${p.code} · ${s.industry || '-'}</div>
        </td>
        <td><span class="pf-plan ${p.plan}">${p.plan === 'B' ? '方案 B' : '方案 A'}</span></td>
        <td><span class="pf-weight">${p.weight}%</span></td>
        <td colspan="6" style="color:var(--dim);text-align:left">資料載入中… (${p.error})</td>
      </tr>`;
    }
    return `
      <tr data-code="${p.code}">
        <td>
          <div class="pf-name">${s.name}</div>
          <div class="pf-code">${p.code} · ${s.industry || '-'}</div>
        </td>
        <td><span class="pf-plan ${p.plan}">${p.plan === 'B' ? '方案 B' : '方案 A'}</span></td>
        <td><span class="pf-weight">${p.weight}%</span></td>
        <td class="pf-num">${p.entry}</td>
        <td class="pf-num" style="color:var(--down)">${fmt(p.stop, 0)}</td>
        <td class="pf-num" style="color:var(--up)">${fmt(p.target, 0)}<br><span style="font-size:10px;color:var(--dim)">+${upPct}%</span></td>
        <td><span class="pf-win ${tone}">${p.win}/10</span></td>
        <td>
          <div class="pf-rate">
            <span class="rate ${p.rate.基本}">基 ${p.rate.基本}</span>
            <span class="rate ${p.rate.籌碼}">籌 ${p.rate.籌碼}</span>
            <span class="rate ${p.rate.技術}">技 ${p.rate.技術}</span>
            <span class="rate ${p.rate.消息}">消 ${p.rate.消息}</span>
          </div>
        </td>
        <td>
          <div class="pf-reason">
            <b style="color:var(--gold)">${p.theme}</b><br>
            ${p.reason}<br>
            <span style="color:var(--neon)">▸ 即時：${p.diagnoseSnapshot?.overall || '--'}</span>
          </div>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => {
      emit('select', tr.dataset.code);
      document.getElementById('stock-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function drawPie() {
  const pieData = [
    ...portfolio.map((p) => ({ name: state.stocks[p.code]?.name || p.code, w: p.weight })),
    { name: '現金', w: 15 },
  ];
  mountChart('chartPortfolio', {
    type: 'doughnut',
    data: {
      labels: pieData.map((p) => `${p.name} ${p.w}%`),
      datasets: [{
        data: pieData.map((p) => p.w),
        backgroundColor: [
          '#ff3b4e', '#ff6478', '#ff8a9b', '#ffb0bd',
          '#7a5cff', '#9d85ff', '#bfaeff', '#d9c8ff',
          '#3a4252',
        ],
        borderColor: '#0c1118', borderWidth: 2,
      }],
    },
    options: {
      plugins: {
        legend: { position: 'right', labels: { color: '#c9d1de', font: { size: 11 }, boxWidth: 12, padding: 7 } },
        title: { display: true, text: '資金配置', color: '#f6c452', font: { size: 13, weight: 'bold' } },
      },
      maintainAspectRatio: false, cutout: '55%', animation: false,
    },
  });
}
