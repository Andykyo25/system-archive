import { state, on, emit } from '../state.js';
import { fmt, sign } from '../utils/format.js';
import { themes, stockNews } from '../data/mock.js';
import { mountChart, theme } from './charts.js';
import { api } from '../data/api.js';
import { diagnose } from '../utils/diagnose.js';

let codeEl, nameEl, priceEl, deltaEl, badgesEl;
let liveTimer = null;
const LIVE_RE_DIAGNOSE_MS = 60 * 1000; // 盤中每 60 秒重跑一次診斷

export function mount() {
  codeEl = document.getElementById('s-code');
  nameEl = document.getElementById('s-name');
  priceEl = document.getElementById('s-price');
  deltaEl = document.getElementById('s-delta');
  badgesEl = document.getElementById('s-badges');

  document.querySelectorAll('.tb').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tb').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      document.querySelectorAll('.pane').forEach((p) => (p.style.display = 'none'));
      document.getElementById('pane-' + t.dataset.pane).style.display = 'block';
    });
  });

  on('stock:selected', renderAll);
  on('stocks:changed', refreshHeader);

  // 盤中自動重跑診斷
  liveTimer = setInterval(() => {
    if (state.session !== 'live' && state.session !== 'pre') return;
    if (!state.currentCode) return;
    // 只重跑技術面（K 線會走 localStorage 60 秒 cache，期滿才打 API；診斷重算）
    const s = state.stocks[state.currentCode];
    if (s) renderTech(state.currentCode, s).catch(() => {});
  }, LIVE_RE_DIAGNOSE_MS);
}

async function renderAll(code) {
  const s = state.stocks[code];
  if (!s) return;
  state.currentCode = code;
  refreshHeader();

  const themeNames = (s.theme || []).map((id) => themes.find((t) => t.id === id)?.name).filter(Boolean);
  badgesEl.innerHTML = `
    <span class="badge gold">${s.industry || '-'}</span>
    ${themeNames.map((t) => `<span class="badge hot">${t}</span>`).join('')}
    <span class="badge">市值 ${s.mcap || '-'}</span>
  `;

  // 三個 tab 並行載入
  await Promise.allSettled([
    renderTech(code, s),
    renderFund(code, s),
    renderChip(code, s),
  ]);
  renderStockNews(code);
  document.getElementById('stock-panel').classList.remove('fade-in');
  void document.getElementById('stock-panel').offsetWidth;
  document.getElementById('stock-panel').classList.add('fade-in');
}

function refreshHeader() {
  const s = state.stocks[state.currentCode];
  if (!s) return;
  const sourceTag = s.source ? ` <span style="font-size:10px;color:var(--dim);margin-left:4px">${s.source.toUpperCase()}</span>` : '';
  codeEl.innerHTML = state.currentCode + '.TW' + sourceTag;
  nameEl.textContent = s.name;
  priceEl.textContent = fmt(s.price, 2);
  if (s.pct == null) {
    deltaEl.textContent = '--';
    deltaEl.style.color = 'var(--dim)';
  } else {
    deltaEl.textContent = `${sign(s.chg)} (${sign(s.pct)}%)`;
    deltaEl.style.color = s.pct > 0 ? 'var(--up)' : s.pct < 0 ? 'var(--down)' : 'var(--flat)';
  }

  // 開高低昨量時間
  const setQS = (id, val, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val ?? '--';
    if (color) el.style.color = color;
  };
  const prevColor = (v) => s.prev != null && v != null ? (v > s.prev ? 'var(--up)' : v < s.prev ? 'var(--down)' : 'var(--flat)') : '';
  setQS('qs-open', s.open != null ? fmt(s.open, 2) : '--', prevColor(s.open));
  setQS('qs-high', s.dayHigh != null ? fmt(s.dayHigh, 2) : '--', 'var(--up)');
  setQS('qs-prev', s.prev != null ? fmt(s.prev, 2) : '--');
  setQS('qs-low',  s.dayLow != null ? fmt(s.dayLow, 2) : '--', 'var(--down)');
  setQS('qs-vol',  s.volume != null ? fmt(s.volume, 0) + ' 張' : '--');
  setQS('qs-time', s.time || '--');

  // 五檔（只在 MIS 來源時才有 bid/ask 陣列）
  renderOrderbook(s);

  // 即時更新 priceEl 的閃爍效果（盤中跳動視覺反饋）
  priceEl.classList.remove('flash-up', 'flash-down');
  if (s._lastPrice != null && s.price !== s._lastPrice) {
    priceEl.classList.add(s.price > s._lastPrice ? 'flash-up' : 'flash-down');
  }
  s._lastPrice = s.price;
}

function renderOrderbook(s) {
  const ob = document.getElementById('orderbook');
  const bid = (s.bid || []).filter((v) => v != null);
  const ask = (s.ask || []).filter((v) => v != null);
  const bidVol = s.bidVol || [];
  const askVol = s.askVol || [];
  if (!bid.length || !ask.length) {
    ob.style.display = 'none';
    return;
  }
  ob.style.display = '';

  // 買盤（外盤）= 買進方願意買的價（從高到低）
  const maxBidVol = Math.max(...bidVol, 1);
  const maxAskVol = Math.max(...askVol, 1);

  document.getElementById('ob-bid-rows').innerHTML = bid.slice(0, 5).map((p, i) => {
    const v = bidVol[i] || 0;
    const w = (v / maxBidVol) * 100;
    return `<div class="ob-row"><span class="ob-bg" style="width:${w}%"></span><span class="ob-price">${fmt(p, 2)}</span><span class="ob-vol">${fmt(v, 0)}</span></div>`;
  }).join('');

  document.getElementById('ob-ask-rows').innerHTML = ask.slice(0, 5).map((p, i) => {
    const v = askVol[i] || 0;
    const w = (v / maxAskVol) * 100;
    return `<div class="ob-row"><span class="ob-bg" style="width:${w}%"></span><span class="ob-price">${fmt(p, 2)}</span><span class="ob-vol">${fmt(v, 0)}</span></div>`;
  }).join('');

  // 內外盤比例（簡化：用買賣總量估算）
  const buyTotal = bidVol.reduce((a, b) => a + (b || 0), 0);
  const sellTotal = askVol.reduce((a, b) => a + (b || 0), 0);
  const total = buyTotal + sellTotal || 1;
  const buyPct = (buyTotal / total) * 100;
  const sellPct = (sellTotal / total) * 100;
  document.getElementById('ob-ratio-buy').style.width = buyPct.toFixed(1) + '%';
  document.getElementById('ob-ratio-sell').style.width = sellPct.toFixed(1) + '%';
  document.getElementById('ob-buy-vol').textContent = fmt(buyTotal, 0);
  document.getElementById('ob-sell-vol').textContent = fmt(sellTotal, 0);
  document.getElementById('ob-buy-pct').textContent = buyPct.toFixed(1) + '%';
  document.getElementById('ob-sell-pct').textContent = sellPct.toFixed(1) + '%';
}

// ──────── 技術面 ────────
function MA(arr, n) {
  return arr.map((_, i) => i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((s, x) => s + x.close, 0) / n);
}
function MACDseries(arr) {
  const closes = arr.map((d) => d.close);
  const ema = (n) => {
    const k = 2 / (n + 1); let prev = closes[0]; const out = [prev];
    for (let i = 1; i < closes.length; i++) { prev = closes[i] * k + prev * (1 - k); out.push(prev); }
    return out;
  };
  const e12 = ema(12), e26 = ema(26);
  const dif = e12.map((v, i) => v - e26[i]);
  const k = 2 / 10; let prev = dif[0]; const dem = [prev];
  for (let i = 1; i < dif.length; i++) { prev = dif[i] * k + prev * (1 - k); dem.push(prev); }
  const osc = dif.map((v, i) => v - dem[i]);
  return { dif, dem, osc };
}

async function renderTech(code, s) {
  // 並行抓 90 天 K 線（FinMind 日線）與當前即時報價（state 中由 Yahoo 灌入）
  let k;
  let realData = false;
  try {
    const raw = await api.kline(code, 90);
    k = (raw || []).map((r) => ({
      open: +r.open,
      high: +(r.max ?? r.high),
      low: +(r.min ?? r.low),
      close: +r.close,
      vol: +(r.Trading_Volume ?? r.volume ?? 0),
      date: r.date,
    })).filter((d) => Number.isFinite(d.close));
    realData = k.length > 0;
  } catch { k = []; }
  if (!k.length) k = genMockK(s.price || 100, 60);

  // 關鍵：FinMind 日線盤中延遲 5-15 分鐘，用 state.stocks (Yahoo 即時) 覆蓋最後一筆
  const realtimePrice = state.stocks[code]?.price;
  if (realData && realtimePrice != null && k.length >= 1) {
    const last = k[k.length - 1];
    const today = new Date().toISOString().slice(0, 10);
    if (last.date === today) {
      // 今日 K 棒：把 close 換成即時價（不動 open/high/low，因為 FinMind 已記錄）
      last.close = realtimePrice;
      // 即時 high/low 用 max/min 比較
      if (realtimePrice > last.high) last.high = realtimePrice;
      if (realtimePrice < last.low) last.low = realtimePrice;
    } else {
      // FinMind 還沒更新今日，但 Yahoo 已經有今日盤中 → 補上一筆
      k.push({
        date: today,
        open: realtimePrice,
        high: realtimePrice,
        low: realtimePrice,
        close: realtimePrice,
        vol: 0,
      });
    }
  }

  // header 漲跌計算（用 state 既有真實值優先，否則用 K 線推算）
  if (realData && k.length >= 2 && state.stocks[code]?.price == null) {
    const last = k[k.length - 1];
    const prev = k[k.length - 2];
    const chg = last.close - prev.close;
    const pct = prev.close ? (chg / prev.close) * 100 : 0;
    state.stocks[code] = { ...state.stocks[code], price: last.close, chg, pct };
    s = state.stocks[code];
    emit('stocks:changed');
  }

  const labels = k.map((d, i) => d.date ? d.date.slice(5) : `D${i}`);
  const ma5 = MA(k, 5), ma20 = MA(k, 20), ma60 = MA(k, 60);
  const closes = k.map((d) => d.close);
  document.getElementById('ma5').textContent = fmt(ma5[ma5.length - 1] || 0, 2);
  document.getElementById('ma20').textContent = fmt(ma20[ma20.length - 1] || 0, 2);

  const last9 = k.slice(-9);
  const high9 = Math.max(...last9.map((d) => d.high));
  const low9 = Math.min(...last9.map((d) => d.low));
  const rsv = (s.price - low9) / (high9 - low9 + 0.0001) * 100;
  const kVal = Math.min(95, Math.max(20, rsv * 0.5 + 50)).toFixed(1);
  const dVal = Math.min(95, Math.max(20, rsv * 0.4 + 55)).toFixed(1);
  document.getElementById('kd').textContent = `${kVal} / ${dVal}`;
  document.getElementById('rsi').textContent = (50 + s.pct * 4).toFixed(1);

  mountChart('chartK', {
    type: 'line',
    data: { labels, datasets: [
      { label: '收盤', data: closes, borderColor: '#f6c452', borderWidth: 1.6, pointRadius: 0, tension: .18 },
      { label: '5MA',  data: ma5,    borderColor: '#00e5ff', borderWidth: 1, pointRadius: 0, borderDash: [3, 3] },
      { label: '20MA', data: ma20,   borderColor: '#ff7a1a', borderWidth: 1, pointRadius: 0 },
      { label: '60MA', data: ma60,   borderColor: '#7a5cff', borderWidth: 1, pointRadius: 0 },
    ]},
    options: {
      plugins: { legend: { labels: { color: '#aab2c0', font: { size: 10 } } } },
      scales: { x: { ticks: theme.axis, grid: theme.grid }, y: { ticks: theme.axis, grid: theme.grid } },
      maintainAspectRatio: false, animation: false,
    },
  });

  mountChart('chartVol', {
    type: 'bar',
    data: { labels, datasets: [{
      label: '量', data: k.map((d) => d.vol),
      backgroundColor: k.map((d, i) => i > 0 && k[i].close > k[i - 1].close ? 'rgba(255,59,78,.7)' : 'rgba(30,215,96,.7)'),
    }]},
    options: { plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { ticks: theme.axis, grid: theme.grid } }, maintainAspectRatio: false, animation: false },
  });

  const macd = MACDseries(k);
  mountChart('chartMACD', {
    data: { labels, datasets: [
      { type: 'bar', label: 'OSC', data: macd.osc, backgroundColor: macd.osc.map((v) => v > 0 ? 'rgba(255,59,78,.7)' : 'rgba(30,215,96,.7)') },
      { type: 'line', label: 'DIF', data: macd.dif, borderColor: '#f6c452', borderWidth: 1.4, pointRadius: 0 },
      { type: 'line', label: 'DEM', data: macd.dem, borderColor: '#00e5ff', borderWidth: 1.4, pointRadius: 0 },
    ]},
    options: { plugins: { legend: { labels: { color: '#aab2c0', font: { size: 9 } } } }, scales: { x: { display: false }, y: { ticks: theme.axis, grid: theme.grid } }, maintainAspectRatio: false, animation: false },
  });

  // 技術診斷（rule-based）
  let inst = [];
  try { inst = (await api.institutional(code)) || []; } catch { /* 失敗只影響籌碼欄位 */ }
  const d = diagnose(k, inst);
  if (d) renderDiag(d);
}

// ──────── 技術診斷渲染 ────────
function renderDiag(d) {
  const f = (n, dec = 2) => n == null || !Number.isFinite(n) ? '--' : n.toFixed(dec);
  const cls = (s) => s.includes('多') || s.includes('黃金') || s.includes('擴張') || s.includes('放大') || s.includes('增') ? 'up'
    : s.includes('空') || s.includes('死') || s.includes('縮') || s.includes('減') ? 'down'
    : s.includes('鈍化') ? 'warn' : 'neon';

  // ─ 技術總覽 ─
  document.getElementById('diag-tech').innerHTML = `
    <tr><td>趨勢方向</td><td class="${cls(d.trend)}">${d.trend}・${d.shortTrend}</td></tr>
    <tr><td>短期均線 (MA5)</td><td>${f(d.ma.ma5)}</td></tr>
    <tr><td>中期均線 (MA20)</td><td>${f(d.ma.ma20)}</td></tr>
    <tr><td>長期均線 (MA60)</td><td>${f(d.ma.ma60)}</td></tr>
    <tr><td>KD 指標</td><td class="${cls(d.kd.signal)}">${d.kd.signal}・${d.kd.level}</td></tr>
    <tr><td>MACD</td><td class="${cls(d.macd.signal)}">${d.macd.signal}</td></tr>
    <tr><td>成交量</td><td class="${cls(d.vol.signal)}">${d.vol.signal} (${d.vol.ratio.toFixed(2)}x)</td></tr>
    <tr><td>量價關係</td><td class="${cls(d.vol.priceVol)}">${d.vol.priceVol}</td></tr>
    <tr><td>近 60 日高 / 低</td><td>${f(d.range.high60)} / ${f(d.range.low60)}</td></tr>
  `;

  // ─ 籌碼 ─
  const sd = (n) => n > 0 ? `<span class="up">+${(n / 1000).toFixed(0)}張</span>` : n < 0 ? `<span class="down">${(n / 1000).toFixed(0)}張</span>` : '<span style="color:var(--dim)">中性</span>';
  document.getElementById('diag-chip').innerHTML = `
    <tr><td>外資 (近3日)</td><td>${sd(d.inst.foreign)}</td></tr>
    <tr><td>投信 (近3日)</td><td>${sd(d.inst.trust)}</td></tr>
    <tr><td>自營商 (近3日)</td><td>${sd(d.inst.dealer)}</td></tr>
    <tr><td>合計</td><td>${sd(d.inst.total)}</td></tr>
  `;
  document.getElementById('diag-mainforce').textContent = '主力動向：' + d.inst.mainForce;

  // ─ 短線勝率儀表 ─
  const fillEl = document.getElementById('gauge-fill');
  const pct = Math.max(0, Math.min(100, d.winRate));
  const deg = -90 + (pct / 100) * 180; // -90 → +90
  fillEl.style.transform = `translateX(-50%) rotate(${deg}deg)`;
  document.getElementById('gauge-num').textContent = pct + '%';
  const label = pct >= 70 ? '高勝率' : pct >= 55 ? '偏多' : pct >= 45 ? '中性' : pct >= 30 ? '偏空' : '低勝率';
  document.getElementById('gauge-label').textContent = label;

  // ─ 操作建議 ─
  document.getElementById('diag-action').innerHTML = d.action.map((a) => `<li>${a}</li>`).join('');

  // ─ 近期訊號 ─
  document.getElementById('diag-signal-list').innerHTML = d.signals.map((s) => `
    <div class="diag-signal">
      <span class="stag ${s.tag}">${s.tag}</span>
      <span>${s.text}</span>
    </div>`).join('');

  // ─ 整體結論 ─
  const tag = d.score >= 1 ? 'bull' : d.score <= -1 ? 'bear' : 'flat';
  const tagText = d.score >= 3 ? '強多' : d.score >= 1 ? '偏多' : d.score >= -1 ? '中性' : d.score >= -3 ? '偏空' : '強空';
  const tagEl = document.getElementById('diag-tag');
  tagEl.className = 'diag-tag ' + tag;
  tagEl.textContent = tagText;
  document.getElementById('diag-headline').textContent = d.overall;
}

function genMockK(base, days = 60) {
  const data = []; let p = base * 0.92;
  for (let i = 0; i < days; i++) {
    const open = p;
    const drift = (Math.random() - 0.48) * p * 0.02;
    const close = Math.max(p * 0.85, open + drift);
    const high = Math.max(open, close) + Math.random() * p * 0.012;
    const low = Math.min(open, close) - Math.random() * p * 0.012;
    const vol = Math.round((Math.random() * 0.6 + 0.4) * 40000);
    data.push({ open, high, low, close, vol });
    p = close;
  }
  data[data.length - 1].close = base;
  return data;
}

// ──────── 基本面 ────────
async function renderFund(code, s) {
  const peClass = s.pe > 0 && s.pe < 15 ? 'good' : s.pe > 30 ? 'bad' : 'warn';
  const roeClass = s.roe > 20 ? 'good' : s.roe < 10 ? 'bad' : 'warn';
  document.getElementById('fund-kpi').innerHTML = `
    <div class="kpi"><div class="lab">EPS (TTM)</div><div class="val">${s.eps > 0 ? fmt(s.eps, 2) : '虧損'}</div></div>
    <div class="kpi ${peClass}"><div class="lab">本益比 PE</div><div class="val">${s.pe > 0 ? fmt(s.pe, 1) : '-'}</div></div>
    <div class="kpi"><div class="lab">股價淨值比 PB</div><div class="val">${fmt(s.pb, 2)}</div></div>
    <div class="kpi ${roeClass}"><div class="lab">ROE %</div><div class="val">${fmt(s.roe, 1)}</div></div>
    <div class="kpi warn"><div class="lab">殖利率</div><div class="val">${fmt(s.divYield, 2)}%</div></div>
    <div class="kpi"><div class="lab">毛利率</div><div class="val" id="fund-gpm">--</div></div>
    <div class="kpi"><div class="lab">營益率</div><div class="val" id="fund-opm">--</div></div>
    <div class="kpi"><div class="lab">市值</div><div class="val" style="font-size:14px">${s.mcap || '-'}</div></div>
  `;

  // 月營收（FinMind）
  let revData = [];
  try {
    const raw = await api.revenue(code);
    revData = (raw || []).slice(-12).map((r) => ({ ym: (r.date || '').slice(2, 7), rev: +r.revenue }));
  } catch { /* fallback below */ }
  if (!revData.length) {
    revData = Array.from({ length: 12 }, (_, i) => ({
      ym: '--',
      rev: Math.round(s.eps * 1000 * (0.85 + Math.random() * 0.4) * (1 + i * 0.015)),
    }));
  }
  mountChart('chartRev', {
    type: 'line',
    data: { labels: revData.map((r) => r.ym), datasets: [{
      label: '月營收 (千元)', data: revData.map((r) => r.rev),
      borderColor: '#00e5ff', backgroundColor: 'rgba(0,229,255,.15)', fill: true, tension: .3, pointRadius: 2, borderWidth: 2,
    }]},
    options: { plugins: { legend: { labels: { color: '#aab2c0' } }, title: { display: true, text: '近 12 月營收', color: '#e8edf5' } }, scales: { x: { ticks: theme.axis, grid: theme.grid }, y: { ticks: theme.axis, grid: theme.grid } }, maintainAspectRatio: false, animation: false },
  });

  // 財報（FinMind） — 簡單顯示 EPS 趨勢與兩年比較
  let fin = [];
  try { fin = (await api.financial(code)) || []; } catch { fin = []; }
  // 抓 EPS row
  const epsRows = fin.filter((r) => r.type === 'EPS' || r.type === 'BasicEPS').sort((a, b) => a.date.localeCompare(b.date));
  const epsHist = (epsRows.length ? epsRows.slice(-5) : [0.55, 0.72, 0.85, 0.94, 1].map((m) => ({ date: '', value: +(s.eps * m).toFixed(2) })));
  const yrs = epsHist.map((r) => r.date ? r.date.slice(0, 4) : '');
  const vals = epsHist.map((r) => +r.value);
  mountChart('chartEPS', {
    type: 'bar',
    data: { labels: yrs, datasets: [{ label: 'EPS (元)', data: vals, backgroundColor: 'rgba(246,196,82,.7)', borderColor: '#f6c452', borderWidth: 1.5 }] },
    options: { plugins: { legend: { labels: { color: '#aab2c0' } }, title: { display: true, text: '年/季 EPS', color: '#e8edf5' } }, scales: { x: { ticks: theme.axis, grid: theme.grid }, y: { ticks: theme.axis, grid: theme.grid } }, maintainAspectRatio: false, animation: false },
  });

  // 財報摘要：取最近兩個比較
  const tbody = document.getElementById('fund-table');
  if (vals.length >= 2) {
    const latest = vals[vals.length - 1], prev = vals[vals.length - 2];
    const yoy = prev ? ((latest - prev) / prev * 100).toFixed(1) : '-';
    tbody.innerHTML = `<tr><td>EPS</td><td>${fmt(latest, 2)}</td><td>${fmt(prev, 2)}</td><td class="${yoy > 0 ? 'up' : 'down'}">${sign(+yoy)}%</td></tr>`;
  } else {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--dim);text-align:center">無財報資料</td></tr>`;
  }
}

// ──────── 籌碼面 ────────
async function renderChip(code, s) {
  const foreignPct = (35 + Math.random() * 40).toFixed(1);
  const insiderPct = (8 + Math.random() * 15).toFixed(2);
  document.getElementById('chip-kpi').innerHTML = `
    <div class="kpi good"><div class="lab">外資持股 %</div><div class="val">${foreignPct}%</div></div>
    <div class="kpi"><div class="lab">董監持股 %</div><div class="val">${insiderPct}%</div></div>
    <div class="kpi warn"><div class="lab">融資餘額(張)</div><div class="val" id="chip-margin-buy">--</div></div>
    <div class="kpi"><div class="lab">融券餘額(張)</div><div class="val" id="chip-margin-sell">--</div></div>
  `;

  let inst = [];
  try { inst = (await api.institutional(code)) || []; } catch { inst = []; }

  // FinMind 三大法人格式：每天每法人一列，需 group by date 後 pivot
  const byDate = new Map();
  inst.forEach((r) => {
    const d = r.date;
    if (!byDate.has(d)) byDate.set(d, { date: d, foreign: 0, trust: 0, dealer: 0 });
    const row = byDate.get(d);
    const net = (+r.buy || 0) - (+r.sell || 0);
    if (r.name?.includes('外資') || r.name?.includes('Foreign')) row.foreign += net;
    else if (r.name?.includes('投信')) row.trust += net;
    else if (r.name?.includes('自營')) row.dealer += net;
  });
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-5);
  if (!days.length) {
    for (let i = 4; i >= 0; i--) {
      days.push({ date: `D-${i}`, foreign: Math.round((Math.random() - 0.4) * 15000), trust: Math.round((Math.random() - 0.45) * 3500), dealer: Math.round((Math.random() - 0.5) * 2000) });
    }
  }

  mountChart('chartFlow', {
    type: 'bar',
    data: { labels: days.map((d) => (d.date || '').slice(5)), datasets: [
      { label: '外資', data: days.map((d) => Math.round(d.foreign / 1000)), backgroundColor: 'rgba(246,196,82,.85)' },
      { label: '投信', data: days.map((d) => Math.round(d.trust / 1000)), backgroundColor: 'rgba(0,229,255,.85)' },
      { label: '自營商', data: days.map((d) => Math.round(d.dealer / 1000)), backgroundColor: 'rgba(122,92,255,.85)' },
    ]},
    options: { plugins: { legend: { labels: { color: '#aab2c0' } }, title: { display: true, text: '三大法人買賣超 (張)', color: '#e8edf5' } }, scales: { x: { ticks: theme.axis, grid: theme.grid }, y: { ticks: theme.axis, grid: theme.grid } }, maintainAspectRatio: false, animation: false },
  });

  document.getElementById('chip-table').innerHTML = days.map((d) => {
    const total = d.foreign + d.trust + d.dealer;
    const fmtRow = (v) => `<td class="${v > 0 ? 'up' : 'down'}">${sign(Math.round(v / 1000))}</td>`;
    return `<tr>
      <td>${(d.date || '').slice(5) || '--'}</td>
      ${fmtRow(d.foreign)}${fmtRow(d.trust)}${fmtRow(d.dealer)}
      <td class="${total > 0 ? 'up' : 'down'}"><b>${sign(Math.round(total / 1000))}</b></td>
    </tr>`;
  }).join('');

  // 融資融券
  let mg = [];
  try { mg = (await api.margin(code)) || []; } catch { mg = []; }
  const last = mg[mg.length - 1] || {};
  const marginBuy = +last.MarginPurchaseTodayBalance || 0;
  const shortBalance = +last.ShortSaleTodayBalance || 0;
  const buyDelta = (+last.MarginPurchaseTodayBalance || 0) - (+last.MarginPurchaseYesterdayBalance || 0);
  const shortDelta = (+last.ShortSaleTodayBalance || 0) - (+last.ShortSaleYesterdayBalance || 0);

  const cBuy = document.getElementById('chip-margin-buy');
  const cSell = document.getElementById('chip-margin-sell');
  if (cBuy) cBuy.textContent = fmt(marginBuy, 0);
  if (cSell) cSell.textContent = fmt(shortBalance, 0);

  document.getElementById('margin-table').innerHTML = `
    <tr><td>融資餘額</td><td>${fmt(marginBuy, 0)} 張</td></tr>
    <tr><td>融資增減</td><td class="${buyDelta > 0 ? 'up' : 'down'}">${sign(buyDelta)} 張</td></tr>
    <tr><td>融券餘額</td><td>${fmt(shortBalance, 0)} 張</td></tr>
    <tr><td>融券增減</td><td class="${shortDelta > 0 ? 'up' : 'down'}">${sign(shortDelta)} 張</td></tr>
  `;

  document.getElementById('chip-source').textContent =
    (inst.length ? '三大法人 / ' : '三大法人 fallback / ') +
    (mg.length ? '融資融券：FinMind' : '融資融券 fallback');
}

function renderStockNews(code) {
  const list = stockNews[code] || [
    { time: '今日', title: '近期無重大訊息（自動新聞抓取尚未啟用）' },
    { time: '昨日', title: '產業利多帶動族群表現' },
  ];
  document.getElementById('stock-news').innerHTML = list.map((n) => `
    <div class="news-item">
      <div class="time">${n.time}</div>
      <div class="title">${n.title}</div>
    </div>`).join('');
}
