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

// 對 portfolio 8 檔並行抓 K 線 + 三大法人 → diagnose → 動態算 entry/stop/target/win
async function evaluate() {
  const tasks = portfolio.map(async (p) => {
    try {
      const [klineRaw, instRaw] = await Promise.all([
        api.kline(p.code, 90),
        api.institutional(p.code).catch(() => []),
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
      const d = diagnose(k, instRaw);
      const close = k[k.length - 1].close;
      // 動態計算
      const entryLow  = Math.round(close * 0.97 * 100) / 100;
      const entryHigh = Math.round(close * 1.01 * 100) / 100;
      const stop      = Math.max(close * 0.93, d?.ma?.ma60 || close * 0.9);
      const target    = Math.max(d?.range?.high60 || 0, close * 1.18);
      const win       = Math.max(5, Math.min(10, Math.round((d?.winRate || 50) / 10)));
      const rate = scoreToGrades(d);
      return {
        ...p,
        close,
        entry: `${fmt(entryLow, 0)} ~ ${fmt(entryHigh, 0)}`,
        stop: Math.round(stop),
        target: Math.round(target),
        win,
        rate,
        diagnoseSnapshot: d,
      };
    } catch (e) {
      return { ...p, error: e.message };
    }
  });
  evaluations = await Promise.all(tasks);
  if (mounted) renderTable();
}

// 把 diagnose 的訊號轉成基/籌/技/消 四面評等
function scoreToGrades(d) {
  if (!d) return { 基本:'C', 籌碼:'C', 技術:'C', 消息:'C' };
  // 基本面：用趨勢 + 量價
  const fund = d.score >= 2 ? 'A' : d.score >= 0 ? 'B' : 'C';
  // 籌碼面：三大法人方向
  const inst = d.inst.total > 1000 ? 'A' : d.inst.total > 0 ? 'B' : 'C';
  // 技術面：MA + KD + MACD
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
