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
// 布林通道 BBands(period, mult)：回 { mid, upper, lower }
function BBands(arr, period = 20, mult = 2) {
  const mid = MA(arr, period);
  const upper = arr.map((_, i) => {
    if (i < period - 1) return null;
    const slice = arr.slice(i - period + 1, i + 1).map((d) => d.close);
    const m = mid[i];
    const v = slice.reduce((s, x) => s + (x - m) ** 2, 0) / period;
    return m + mult * Math.sqrt(v);
  });
  const lower = arr.map((_, i) => {
    if (i < period - 1) return null;
    const slice = arr.slice(i - period + 1, i + 1).map((d) => d.close);
    const m = mid[i];
    const v = slice.reduce((s, x) => s + (x - m) ** 2, 0) / period;
    return m - mult * Math.sqrt(v);
  });
  return { mid, upper, lower };
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
  const realtimeVol = state.stocks[code]?.volume; // MIS 累計成交張數
  if (realData && realtimePrice != null && k.length >= 1) {
    const last = k[k.length - 1];
    const today = new Date().toISOString().slice(0, 10);
    if (last.date === today) {
      // 今日 K 棒：把 close 換成即時價（不動 open/high/low，因為 FinMind 已記錄）
      last.close = realtimePrice;
      if (realtimePrice > last.high) last.high = realtimePrice;
      if (realtimePrice < last.low) last.low = realtimePrice;
      // MIS 量大於 FinMind 紀錄時，採 MIS 量（盤中即時）
      if (Number.isFinite(realtimeVol) && realtimeVol > (last.vol || 0)) last.vol = realtimeVol;
    } else {
      // FinMind 還沒更新今日，但 Yahoo 已經有今日盤中 → 補上一筆（vol 用 MIS 數據）
      k.push({
        date: today,
        open: state.stocks[code]?.open ?? realtimePrice,
        high: state.stocks[code]?.dayHigh ?? realtimePrice,
        low:  state.stocks[code]?.dayLow  ?? realtimePrice,
        close: realtimePrice,
        vol: Number.isFinite(realtimeVol) ? realtimeVol : 0,
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
  const bb = BBands(k, 20, 2);
  const closes = k.map((d) => d.close);
  document.getElementById('ma5').textContent = fmt(ma5[ma5.length - 1] || 0, 2);
  document.getElementById('ma20').textContent = fmt(ma20[ma20.length - 1] || 0, 2);
  // 布林軌道 KPI（上 / 下）
  const bbEl = document.getElementById('bbBand');
  if (bbEl) {
    const upN = bb.upper[bb.upper.length - 1];
    const loN = bb.lower[bb.lower.length - 1];
    if (upN != null && loN != null) {
      const lastClose = closes[closes.length - 1];
      const within = lastClose > loN && lastClose < upN;
      const pos = lastClose >= upN ? '<span style="color:var(--down)">突破上軌</span>' :
                  lastClose <= loN ? '<span style="color:var(--up)">跌破下軌</span>' :
                  within ? '<span style="color:var(--dim)">通道內</span>' : '';
      bbEl.innerHTML = `${fmt(upN, 1)} / ${fmt(loN, 1)} <div style="font-size:10px;margin-top:2px">${pos}</div>`;
    } else {
      bbEl.textContent = '--';
    }
  }

  const last9 = k.slice(-9);
  const high9 = Math.max(...last9.map((d) => d.high));
  const low9 = Math.min(...last9.map((d) => d.low));
  const rsv = (s.price - low9) / (high9 - low9 + 0.0001) * 100;
  const kVal = Math.min(95, Math.max(20, rsv * 0.5 + 50)).toFixed(1);
  const dVal = Math.min(95, Math.max(20, rsv * 0.4 + 55)).toFixed(1);
  document.getElementById('kd').textContent = `${kVal} / ${dVal}`;
  // RSI 留待 server diagnose 回填（renderTechKpis 會覆蓋為真實 RSI(14)）
  document.getElementById('rsi').textContent = '計算中…';

  mountChart('chartK', {
    type: 'line',
    data: { labels, datasets: [
      // 布林軌道 — 上軌（透明填到下軌）
      { label: 'BB 上軌', data: bb.upper, borderColor: 'rgba(122,92,255,.55)', borderWidth: 1, pointRadius: 0, borderDash: [2, 3], fill: '+2', backgroundColor: 'rgba(122,92,255,.06)' },
      { label: 'BB 中軌', data: bb.mid,   borderColor: 'rgba(122,92,255,.4)', borderWidth: 1, pointRadius: 0, borderDash: [4, 4] },
      { label: 'BB 下軌', data: bb.lower, borderColor: 'rgba(122,92,255,.55)', borderWidth: 1, pointRadius: 0, borderDash: [2, 3] },
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

  // 盤中即時走勢（不阻塞主流程）
  renderIntraday(code).catch(() => {});

  // 技術診斷 — 統一向後端拿（與 AI 智選共用同一份 diagnose 結果，避免雙路徑差異）
  let d = null;
  let diagError = null;
  try {
    d = await api.diagnose(code);
  } catch (err) {
    diagError = err.message;
    // 後端失敗時 fallback 到本地計算（為了不阻塞 UI）
    try {
      let inst = [];
      let sh = null;
      try { inst = (await api.institutional(code)) || []; } catch {}
      try { sh = await api.shareholding(code); } catch {}
      d = diagnose(k, inst, { sharesOutstanding: sh?.sharesOutstanding || null });
    } catch (e2) {
      console.warn('[diag local fallback]', e2.message);
    }
  }
  if (d) {
    renderDiag(d, k);
    renderTechKpis(d);
  } else {
    renderDiagError(diagError || '無法產生診斷');
  }
}

// 診斷失敗時的友善 empty state（保留價量資訊，標出哪一段壞了）
function renderDiagError(msg) {
  const tagEl = document.getElementById('diag-tag');
  const headEl = document.getElementById('diag-headline');
  if (tagEl) { tagEl.className = 'diag-tag flat'; tagEl.textContent = '無法診斷'; }
  if (headEl) headEl.textContent = msg;

  document.getElementById('diag-tech').innerHTML = `<tr><td colspan="2" style="color:var(--dim);text-align:center;padding:20px">${msg}<br><span style="font-size:10px">技術指標暫無法計算 — 可能為週末/盤後 + 第三方 API 限流</span></td></tr>`;
  document.getElementById('diag-chip').innerHTML = `<tr><td colspan="2" style="color:var(--dim);text-align:center;padding:20px">籌碼資料載入失敗</td></tr>`;
  document.getElementById('diag-mainforce').textContent = '';
  document.getElementById('diag-action').innerHTML = '<li style="color:var(--dim)">資料完整度不足，暫不提供操作建議</li>';
  document.getElementById('diag-signal-list').innerHTML = `<div style="color:var(--dim);font-size:11px;padding:8px">無法產生訊號</div>`;
  // 勝率儀表清空
  const fillEl = document.getElementById('gauge-fill');
  if (fillEl) fillEl.style.transform = `translateX(-50%) rotate(-90deg)`;
  document.getElementById('gauge-num').textContent = '--';
  document.getElementById('gauge-label').textContent = '資料不足';
  // 驗證面板清空
  ['val-consistency', 'val-accuracy', 'val-liquidity', 'val-cost'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '--';
  });
  // 操作劇本清空
  const pbText = document.getElementById('diag-playbook-text');
  if (pbText) pbText.textContent = '資料完整度不足，暫不提供操作劇本';
  const pbLevels = document.getElementById('diag-levels');
  if (pbLevels) pbLevels.innerHTML = '';
}

// 盤中分時即時走勢圖（1 分 K，當日）
async function renderIntraday(code) {
  const statEl = document.getElementById('intraday-stat');
  const canvas = document.getElementById('chartIntraday');
  if (!canvas) return;

  let resp;
  try {
    resp = await api.intraday(code, '1m');
  } catch (e) {
    if (statEl) statEl.textContent = '盤中資料載入失敗';
    return;
  }
  const points = resp?.points || [];
  if (!points.length) {
    if (statEl) statEl.textContent = '今日尚未開盤 / 無分時資料';
    mountChart('chartIntraday', {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: { plugins: { legend: { display: false } }, maintainAspectRatio: false, animation: false },
    });
    return;
  }

  const prevClose = resp?.meta?.prevClose;
  const labels = points.map((p) => p.time);
  const closes = points.map((p) => p.close);
  const last = closes[closes.length - 1];
  const high = Math.max(...closes);
  const low  = Math.min(...closes);
  const totalVol = points.reduce((s, p) => s + (p.volume || 0), 0);
  const pct = prevClose ? ((last - prevClose) / prevClose) * 100 : 0;
  const upColor = pct >= 0 ? '#ff3b4e' : '#1ed760';

  if (statEl) {
    statEl.innerHTML = `現價 <b style="color:${upColor}">${fmt(last, 2)}</b> · `
      + `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% · `
      + `日高 ${fmt(high, 2)} / 日低 ${fmt(low, 2)} · `
      + `成交 ${fmt(totalVol, 0)}`;
  }

  // 平盤線：用昨收
  const flatLine = prevClose != null ? closes.map(() => prevClose) : null;

  const datasets = [
    { label: '當日走勢', data: closes, borderColor: upColor, backgroundColor: pct >= 0 ? 'rgba(255,59,78,.10)' : 'rgba(30,215,96,.10)', borderWidth: 1.6, pointRadius: 0, tension: .15, fill: true },
  ];
  if (flatLine) {
    datasets.push({ label: '昨收', data: flatLine, borderColor: 'rgba(170,178,192,.5)', borderDash: [4, 4], borderWidth: 1, pointRadius: 0 });
  }

  mountChart('chartIntraday', {
    type: 'line',
    data: { labels, datasets },
    options: {
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
      scales: {
        x: { ticks: { ...theme.axis, maxTicksLimit: 8 }, grid: theme.grid },
        y: { ticks: theme.axis, grid: theme.grid },
      },
      maintainAspectRatio: false, animation: false,
    },
  });
}

// 過擬合對策面板：共識度、歷史命中率、流動性、成本可行性
function renderValidation(d) {
  // 1. 四面共識度
  const cEl = document.getElementById('val-consistency');
  if (cEl) {
    const c = d.consistency ?? 0;
    const tone = c >= 75 ? 'var(--up)' : c >= 50 ? 'var(--gold)' : 'var(--down)';
    const lab = c >= 75 ? '高（訊號一致）' : c >= 50 ? '中（部分分歧）' : '低（模組互打）';
    cEl.innerHTML = `<span style="color:${tone}">${c}%</span> <span style="color:var(--dim);font-size:10px">${lab}</span>`;
  }

  // 2. Walk-forward 歷史命中率
  const aEl = document.getElementById('val-accuracy');
  if (aEl) {
    if (!d.historicalAccuracy) {
      aEl.innerHTML = `<span style="color:var(--dim)">樣本不足</span>`;
    } else {
      const h = d.historicalAccuracy;
      const tone = h.hitRate >= 60 ? 'var(--up)' : h.hitRate >= 50 ? 'var(--gold)' : 'var(--down)';
      const note = h.hitRate >= 55 ? '可信度高' : h.hitRate >= 45 ? '與隨機接近' : '反向更佳？';
      aEl.innerHTML = `<span style="color:${tone}">${h.hitRate}%</span> `
        + `<span style="color:var(--dim);font-size:10px">(${h.samples} 筆樣本 · ${note})</span>`;
    }
  }

  // 3. 流動性
  const lEl = document.getElementById('val-liquidity');
  if (lEl) {
    const lq = d.economic?.liquidity || 'unknown';
    const turn = d.economic?.avgTurnover20;
    const turnText = turn ? (turn >= 1e8 ? (turn / 1e8).toFixed(1) + ' 億/日' : (turn / 1e4).toFixed(0) + ' 萬/日') : '--';
    const map = {
      high: { tone: 'var(--up)', text: '高' },
      mid:  { tone: 'var(--gold)', text: '中' },
      low:  { tone: 'var(--down)', text: '低（訊號雜訊較多）' },
      unknown: { tone: 'var(--dim)', text: '--' },
    };
    const m = map[lq];
    lEl.innerHTML = `<span style="color:${m.tone}">${m.text}</span> <span style="color:var(--dim);font-size:10px">${turnText}</span>`;
  }

  // 4. 成本可行性
  const ceEl = document.getElementById('val-cost');
  if (ceEl) {
    const e = d.economic;
    if (!e) { ceEl.textContent = '--'; }
    else {
      const tone = e.costFeasible ? 'var(--up)' : 'var(--down)';
      const lab = e.costFeasible ? '可覆蓋' : '不足 2x 成本';
      ceEl.innerHTML = `<span style="color:${tone}">${lab}</span> `
        + `<span style="color:var(--dim);font-size:10px">目標 +${e.expectedReturn}% / 成本 ${e.txCostPct}%</span>`;
    }
  }

  // 6. 真實預測追蹤（自我學習回饋）
  const pEl = document.getElementById('val-personal');
  if (pEl) {
    const pa = d.personalAccuracy;
    if (!pa || pa.samples == null || pa.samples < 1) {
      pEl.innerHTML = `<span style="color:var(--dim)">尚無已驗證預測（需累積 ≥ 5 筆樣本後啟動準確度修正）${pa?.pending ? `；待驗證 ${pa.pending} 筆` : ''}</span>`;
    } else {
      const last = pa.last;
      const hitRateColor = pa.recentHitRate >= 60 ? 'var(--up)' : pa.recentHitRate >= 50 ? 'var(--gold)' : 'var(--down)';
      const mulColor = pa.multiplier > 1 ? 'var(--up)' : pa.multiplier < 1 ? 'var(--down)' : 'var(--dim)';
      const lines = [];
      lines.push(`<div style="display:flex;justify-content:space-between">
        <span style="color:var(--dim)">本股近期命中率</span>
        <span style="font-family:'JetBrains Mono',monospace;font-weight:700"><span style="color:${hitRateColor}">${pa.recentHitRate}%</span> <span style="color:var(--dim);font-size:9px">(${pa.samples} 筆)</span></span>
      </div>`);
      if (pa.mae != null) {
        lines.push(`<div style="display:flex;justify-content:space-between">
          <span style="color:var(--dim)">平均絕對誤差 (MAE)</span>
          <span style="font-family:'JetBrains Mono',monospace;font-weight:700">${pa.mae}%</span>
        </div>`);
      }
      lines.push(`<div style="display:flex;justify-content:space-between">
        <span style="color:var(--dim)">信心倍率（已套用）</span>
        <span style="font-family:'JetBrains Mono',monospace;font-weight:700;color:${mulColor}">×${pa.multiplier} <span style="color:var(--dim);font-size:9px">(基準勝率 ${pa.baseWinRate}% → 校正後 ${d.winRate}%)</span></span>
      </div>`);
      if (last) {
        const errColor = Math.abs(last.error || 0) <= 2 ? 'var(--up)' : Math.abs(last.error || 0) <= 5 ? 'var(--gold)' : 'var(--down)';
        lines.push(`<div style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line);color:var(--dim);font-size:9.5px">
          上次驗證 [${last.date}→${last.actualDate}]：預測 ${last.direction === 'long' ? '↑' : last.direction === 'short' ? '↓' : '→'} ${last.predictedReturn != null ? (last.predictedReturn > 0 ? '+' : '') + last.predictedReturn + '%' : '--'}
          / 實際 ${last.actualReturn > 0 ? '+' : ''}${last.actualReturn}%
          / 誤差 <span style="color:${errColor}">${last.error > 0 ? '+' : ''}${last.error}%</span>
          / ${last.hit ? '<span style="color:var(--up)">方向命中 ✓</span>' : '<span style="color:var(--down)">方向誤判 ✗</span>'}
        </div>`);
      }
      if (pa.consecutiveBigError) {
        lines.push(`<div style="margin-top:4px;padding:4px 6px;background:var(--up-soft);border-left:2px solid var(--up);color:var(--up);font-size:10px;border-radius:3px">
          ⚠ 連 3 筆誤差 > 5% — 此股近期模型不準，建議降低部位或觀望
        </div>`);
      }
      pEl.innerHTML = lines.join('');
    }
  }

  // 5. 各 view 命中率 / 動態權重
  const mEl = document.getElementById('val-modules');
  if (mEl) {
    const acc = d.moduleAccuracy || {};
    const dw = d.dynamicWeights?.weights || {};
    const fac = d.dynamicWeights?.factors || {};
    const labels = { trend: '趨勢', momentum: '動能', volPrice: '量價', chip: '籌碼' };
    const cell = (key) => {
      const a = acc[key];
      const w = dw[key];
      const f = fac[key];
      const hit = a?.hitRate;
      const sample = a?.samples ?? 0;
      // 顏色：命中率 + 權重變化
      let hitColor = 'var(--dim)';
      if (hit != null) {
        hitColor = hit >= 60 ? 'var(--up)' : hit >= 50 ? 'var(--gold)' : hit >= 40 ? 'var(--down)' : 'var(--down)';
      }
      const arrow = f == null || f === 1 ? '' : (f > 1 ? '↑' : '↓');
      const arrowColor = f > 1 ? 'var(--up)' : f < 1 ? 'var(--down)' : 'var(--dim)';
      const hitText = key === 'chip'
        ? '<span style="color:var(--dim);font-size:9px">無歷史樣本</span>'
        : (hit != null
          ? `<span style="color:${hitColor}">${hit}%</span><span style="color:var(--dim);font-size:9px"> (${sample})</span>`
          : `<span style="color:var(--dim)">--</span>`);
      return `<div style="background:var(--bg-3);padding:4px 6px;border-radius:3px;display:flex;justify-content:space-between;align-items:center">
        <span style="color:var(--dim)">${labels[key]}</span>
        <span>${hitText} <span style="color:${arrowColor};font-weight:700">${arrow}${(w * 100).toFixed(0)}%</span></span>
      </div>`;
    };
    mEl.innerHTML = ['trend', 'momentum', 'volPrice', 'chip'].map(cell).join('');
  }
}

// 把 Bias / ATR / 扣抵值 / RSI / KD 寫進 KPI 卡片，並依條件加紅警示
function renderTechKpis(d) {
  const biasEl = document.getElementById('bias20');
  const atrEl = document.getElementById('atr14');
  const dedEl = document.getElementById('maDeduct20');
  // RSI(14) — 真實計算（Wilder）
  const rsiEl = document.getElementById('rsi');
  if (rsiEl && d.rsi14 != null) {
    rsiEl.textContent = d.rsi14.toFixed(1);
    rsiEl.style.color = d.rsi14 > 70 ? 'var(--down)' : d.rsi14 < 30 ? 'var(--up)' : '';
  }
  // KD — 用 server diagnose 真實值覆蓋
  const kdEl = document.getElementById('kd');
  if (kdEl && d.kd?.k != null && d.kd?.d != null) {
    kdEl.textContent = `${d.kd.k.toFixed(1)} / ${d.kd.d.toFixed(1)}`;
  }
  if (biasEl) {
    if (d.bias20 == null) {
      biasEl.textContent = '--';
      biasEl.style.color = '';
    } else {
      biasEl.textContent = (d.bias20 > 0 ? '+' : '') + d.bias20.toFixed(2) + '%';
      biasEl.style.color = d.bias20 > 10 ? 'var(--down)' : d.bias20 < -10 ? 'var(--up)' : '';
    }
  }
  if (atrEl) {
    atrEl.textContent = d.atr14 != null ? `±${d.atr14.toFixed(2)} 元` : '--';
  }
  if (dedEl) {
    dedEl.textContent = d.maDeduct20 != null ? fmt(d.maDeduct20, 2) : '--';
  }
}

// ──────── 技術診斷渲染 ────────
function renderDiag(d, k) {
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

  // ─ 過擬合對策驗證指標 ─
  renderValidation(d);

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

  // ─ 操作劇本 ─
  const pbText = document.getElementById('diag-playbook-text');
  const pbLevels = document.getElementById('diag-levels');
  if (pbText && d.playbook) pbText.textContent = d.playbook;
  if (pbLevels && d.levels) {
    const L = d.levels;
    const cell = (lab, val, color) => `
      <div style="background:var(--bg-3);padding:8px 10px;border-radius:5px">
        <div style="font-size:9px;color:var(--dim);letter-spacing:1px;margin-bottom:3px">${lab}</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:${color || 'var(--txt)'}">${val ?? '--'}</div>
      </div>`;
    // 方向感：long=做多視角；short=只顯示參考支撐/壓力，不顯示停利目標誤導
    const dir = d.direction || (d.winRate >= 55 ? 'long' : d.winRate >= 45 ? 'neutral' : 'short');
    let cells;
    if (dir === 'long') {
      cells = [
        cell('進場區下', L.entryLow, 'var(--gold)'),
        cell('進場區上', L.entryHigh, 'var(--gold)'),
        cell('停損', L.stop, 'var(--down)'),
        cell('停利①', L.target1, 'var(--up)'),
        cell('停利②', L.target2, 'var(--up)'),
        cell('5MA 支撐', L.support10, 'var(--neon)'),
        cell('20MA 支撐', L.support20, 'var(--neon-2)'),
        cell('60 日高', L.high60, 'var(--up)'),
        cell('60 日低', L.low60, 'var(--down)'),
      ];
    } else if (dir === 'neutral') {
      cells = [
        cell('區間下緣', L.support10, 'var(--neon)'),
        cell('區間上緣', L.entryHigh, 'var(--gold)'),
        cell('多方確認', L.high60, 'var(--up)'),
        cell('空方確認', L.low60, 'var(--down)'),
        cell('20MA 中軸', L.support20, 'var(--neon-2)'),
        cell('停損參考', L.stop, 'var(--down)'),
      ];
    } else {
      // short：只顯示反彈壓力與支撐，不顯示「進場區/停利目標」避免誤導
      cells = [
        cell('反彈壓力①', L.support10, 'var(--gold)'),       // 5MA 反彈即減
        cell('反彈壓力②', L.support20, 'var(--gold)'),       // 20MA 翻多訊號
        cell('現有部位停損', L.stop, 'var(--down)'),
        cell('60 日高', L.high60, 'var(--up)'),
        cell('60 日低（破底警戒）', L.low60, 'var(--down)'),
      ];
    }
    pbLevels.innerHTML = cells.join('');
  }
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
  // 並行抓 fundamentals（整合 BWIBBU + financial + shareholding + 市值）
  let f = {};
  try { f = await api.fundamentals(code); } catch { f = {}; }

  // 把抓到的數值寫回 state.stocks（讓其他模組共用）
  if (state.stocks[code]) {
    Object.assign(state.stocks[code], {
      pe: f.pe, pb: f.pb, divYield: f.divYield,
      eps: f.epsTTM ?? f.epsLastQ,
      roe: f.roe, gpm: f.gpm, opm: f.opm,
      foreignPct: f.foreignPct,
      sharesOutstanding: f.sharesOutstanding,
      mcap: f.mcap,
    });
  }

  // 顏色判定
  const peClass = (f.pe > 0 && f.pe < 15) ? 'good' : f.pe > 30 ? 'bad' : f.pe ? 'warn' : '';
  const roeClass = f.roe > 20 ? 'good' : f.roe > 0 && f.roe < 10 ? 'bad' : f.roe ? 'warn' : '';
  const eps = f.epsTTM ?? f.epsLastQ;

  // 市值轉「兆 / 億」
  const mcapText = (m) => {
    if (!m) return '--';
    if (m >= 1e12) return (m / 1e12).toFixed(2) + ' 兆';
    if (m >= 1e8) return (m / 1e8).toFixed(0) + ' 億';
    return fmt(m, 0);
  };

  document.getElementById('fund-kpi').innerHTML = `
    <div class="kpi"><div class="lab">EPS ${f.epsTTM != null ? '(TTM)' : '(最新季)'}</div><div class="val">${eps != null ? (eps > 0 ? fmt(eps, 2) : '虧損') : '--'}</div></div>
    <div class="kpi ${peClass}"><div class="lab">本益比 PE</div><div class="val">${f.pe != null ? fmt(f.pe, 1) : '--'}</div></div>
    <div class="kpi"><div class="lab">股價淨值比 PB</div><div class="val">${f.pb != null ? fmt(f.pb, 2) : '--'}</div></div>
    <div class="kpi ${roeClass}"><div class="lab">ROE % (年化)</div><div class="val">${f.roe != null ? fmt(f.roe, 1) : '--'}</div></div>
    <div class="kpi warn"><div class="lab">殖利率</div><div class="val">${f.divYield != null ? fmt(f.divYield, 2) + '%' : '--'}</div></div>
    <div class="kpi ${f.gpm > 30 ? 'good' : ''}"><div class="lab">毛利率</div><div class="val">${f.gpm != null ? fmt(f.gpm, 1) + '%' : '--'}</div></div>
    <div class="kpi ${f.opm > 15 ? 'good' : ''}"><div class="lab">營益率</div><div class="val">${f.opm != null ? fmt(f.opm, 1) + '%' : '--'}</div></div>
    <div class="kpi"><div class="lab">市值</div><div class="val" style="font-size:14px">${mcapText(f.mcap)}</div></div>
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
// 從 TaiwanStockHoldingSharesPer 結構抽出「外資/法人」與「散戶」概略：
//   分級表的「1-999 股」「1,000-5,000」… 通常代表散戶；最大級距「>1,000 張」≈ 大戶＋法人
function pickShareholderPct(rows) {
  if (!Array.isArray(rows) || !rows.length) return { foreignPct: null, insiderPct: null, majorPct: null };
  // 取最近一筆 date
  const lastDate = rows.map((r) => r.date).sort().pop();
  const day = rows.filter((r) => r.date === lastDate);
  // 1000 張以上（級距 = 15 或文字含「1,000,001」「1000張」）= 大戶
  const major = day.find((r) => /1000.?(張)|超過|1,000,001|>1,000,000/.test(r.HoldingSharesLevel || r.level || ''));
  const small = day.find((r) => /^\s*1\b|1-999|1股以下/.test(r.HoldingSharesLevel || r.level || ''));
  const num = (v) => Number.isFinite(+v) ? +v : null;
  return {
    majorPct: num(major?.percent ?? major?.percentage),
    smallPct: num(small?.percent ?? small?.percentage),
    foreignPct: null, // 此 dataset 不直接提供外資 %，需另外接 TaiwanStockShareholding
    insiderPct: null,
    lastDate,
  };
}

function calcMajorWeekChange(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  // 依 date asc，挑「1,000 張以上」級距
  const lvlRe = /1000.?(張)|超過|1,000,001|>1,000,000/;
  const major = rows.filter((r) => lvlRe.test(r.HoldingSharesLevel || r.level || ''))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (major.length < 2) return null;
  const last = +major[major.length - 1].percent;
  // 找約一週前（5 個交易日）— 這個 dataset 通常週更，挑前一筆即可
  const prev = +major[major.length - 2].percent;
  if (!Number.isFinite(last) || !Number.isFinite(prev)) return null;
  return last - prev;
}

async function renderChip(code, s) {
  // 並行抓：外資 % (fundamentals)、大戶結構、三大法人、融資融券
  let foreignPct = null;
  let majorPct = null;

  try {
    const f = await api.fundamentals(code);
    foreignPct = f?.foreignPct;
  } catch { /* ignore */ }

  // 大戶 % 從 shareholders 級距抽（FinMind TaiwanStockHoldingSharesPer）
  try {
    const shareholders = (await api.shareholders(code)) || [];
    const sh = pickShareholderPct(shareholders);
    majorPct = sh.majorPct;
  } catch { /* ignore */ }

  const foreignTxt = foreignPct != null ? foreignPct.toFixed(2) + '%' : '--';
  const majorTxt = majorPct != null ? majorPct.toFixed(2) + '%' : '--';

  document.getElementById('chip-kpi').innerHTML = `
    <div class="kpi good"><div class="lab">外資持股 %</div><div class="val">${foreignTxt}</div></div>
    <div class="kpi"><div class="lab">大戶持股 % (>1000張)</div><div class="val">${majorTxt}</div></div>
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

  // ─ 新增 4 KPI：投信佔股本 / 融資維持率 / 券資比 / 大戶持股週變 ─
  // 投信佔股本：取近 3 日 trustPctOfCap 累加（server 端已 join），fallback 用 sharesOutstanding 自算
  let trustPct = null;
  const recentDates = [...new Set(inst.map((r) => r.date))].sort().slice(-3);
  const trustRows = inst.filter((r) => recentDates.includes(r.date) && r.name?.includes('投信'));
  const withPct = trustRows.filter((r) => Number.isFinite(+r.trustPctOfCap));
  if (withPct.length) {
    trustPct = withPct.reduce((sum, r) => sum + (+r.trustPctOfCap), 0);
  } else {
    try {
      const shInfo = await api.shareholding(code);
      const cap = shInfo?.sharesOutstanding;
      if (cap) {
        const trustNet = trustRows.reduce((sum, r) => sum + ((+r.buy || 0) - (+r.sell || 0)), 0);
        trustPct = (trustNet / cap) * 100;
      }
    } catch {/* ignore */}
  }
  const trustEl = document.getElementById('trustPctCap');
  if (trustEl) {
    if (trustPct == null) {
      trustEl.textContent = '--';
      trustEl.style.color = '';
    } else {
      trustEl.textContent = (trustPct > 0 ? '+' : '') + trustPct.toFixed(3) + '%';
      trustEl.style.color = trustPct > 0.5 ? 'var(--up)' : trustPct < -0.5 ? 'var(--down)' : '';
    }
  }

  // 融資維持率 = (TodayBalance × 收盤價 × 1.6) / MarginPurchaseAmount × 100
  // 若 MarginPurchaseAmount 不存在（FinMind 此 dataset 通常無此欄位），改採近似法：
  //   maint ≈ (close / avg_buy_price) × (1 / 0.6) × 100，avg_buy_price 用近 60 日均收盤
  const close = state.stocks[code]?.price || s.price || 0;
  let maint = null;
  if (Number.isFinite(+last.MarginPurchaseAmount) && +last.MarginPurchaseAmount > 0 && marginBuy > 0 && close) {
    maint = (marginBuy * close * 1.6) / +last.MarginPurchaseAmount * 100;
  } else if (close && mg.length >= 30) {
    const avgBuy = mg.slice(-60).reduce((sum, r) => sum + (+r.MarginPurchaseTodayBalance || 0), 0) / Math.min(60, mg.length);
    // 近似：用近期均餘為「假設買進價」並非完全準確，但可給出維持率方向訊號
    if (avgBuy > 0) {
      maint = (marginBuy * close) / (avgBuy * close * 0.6) * 100;
    }
  }
  const maintEl = document.getElementById('marginMaint');
  if (maintEl) {
    if (maint == null) {
      maintEl.textContent = '--';
      maintEl.style.color = '';
    } else {
      maintEl.textContent = maint.toFixed(0) + '%';
      maintEl.style.color = maint < 130 ? 'var(--down)' : maint > 166 ? 'var(--up)' : '';
    }
  }

  // 券資比 = ShortSaleTodayBalance / MarginPurchaseTodayBalance × 100
  const slRatio = marginBuy > 0 ? (shortBalance / marginBuy) * 100 : null;
  const slEl = document.getElementById('shortLongRatio');
  if (slEl) {
    if (slRatio == null) {
      slEl.textContent = '--';
      slEl.style.color = '';
    } else {
      slEl.textContent = slRatio.toFixed(1) + '%';
      slEl.style.color = slRatio > 30 ? 'var(--gold)' : '';
    }
  }

  // 軋空候選 badge：券資比 > 30% 且 融資減少
  const badgesEl = document.getElementById('s-badges');
  if (badgesEl) {
    const exists = badgesEl.querySelector('[data-tag="squeeze"]');
    if (slRatio != null && slRatio > 30 && buyDelta < 0) {
      if (!exists) {
        const span = document.createElement('span');
        span.className = 'badge gold';
        span.dataset.tag = 'squeeze';
        span.textContent = '軋空候選';
        badgesEl.appendChild(span);
      }
    } else if (exists) {
      exists.remove();
    }
  }

  // 大戶持股週變
  const wow = calcMajorWeekChange(shareholders);
  const wowEl = document.getElementById('majorWow');
  if (wowEl) {
    if (wow == null) {
      wowEl.textContent = '--';
      wowEl.style.color = '';
    } else {
      wowEl.textContent = (wow > 0 ? '+' : '') + wow.toFixed(2) + '%';
      wowEl.style.color = wow > 0 ? 'var(--up)' : wow < 0 ? 'var(--down)' : '';
    }
  }
}

async function renderStockNews(code) {
  const box = document.getElementById('stock-news');
  box.innerHTML = `<div class="news-item"><div class="title" style="color:var(--dim)">載入個股新聞中…</div></div>`;

  const stock = state.stocks[code];
  const stockName = stock?.name || '';

  try {
    // 多源聚合：鉅亨網全文搜尋 + Yahoo Finance 新聞 + 多分類過濾
    const keyword = stockName ? `${code} ${stockName}` : code;
    let list = await api.news('tw_stock', 30, keyword);

    // 仍要做一次本地過濾（搜尋 API 偶會帶回部分模糊命中）
    const codeRegex = new RegExp(`(?<!\\d)${code}(?!\\d)`);
    let filtered = (list || []).filter((n) => {
      const text = `${n.title} ${n.summary || ''}`;
      return codeRegex.test(text) || (stockName && text.includes(stockName));
    });

    // 二次備援：若搜尋沒結果，退回 tw_stock 多分類聚合過濾
    if (!filtered.length) {
      const fallback = await api.news('tw_stock', 80);
      filtered = (fallback || []).filter((n) => {
        const text = `${n.title} ${n.summary || ''}`;
        return codeRegex.test(text) || (stockName && text.includes(stockName));
      });
    }

    filtered = filtered.slice(0, 20);

    if (!filtered.length) {
      box.innerHTML = `
        <div class="news-item"><div class="time">--</div>
          <div class="title" style="color:var(--dim)">未找到 ${stockName}（${code}）相關新聞 — 已嘗試 鉅亨網全文搜尋 + Yahoo Finance + 多分類聚合</div>
        </div>`;
      return;
    }

    box.innerHTML = filtered.map((n) => {
      const url = n.url ? `href="${n.url}" target="_blank" rel="noopener"` : '';
      const urgent = n.publishAt && (Date.now() / 1000 - n.publishAt < 3600);
      const sourceTag = n.source && n.source !== '鉅亨網' ? ` · ${n.source}` : '';
      return `
        <a class="news-item" ${url} style="display:block;color:inherit;text-decoration:none">
          <div class="time">${n.time}<span class="tag ${urgent ? 'urgent' : ''}" style="margin-left:6px">${n.category || '台股'}${sourceTag}</span></div>
          <div class="title">${n.title}</div>
          ${n.summary ? `<div style="color:var(--dim);font-size:11px;margin-top:4px;line-height:1.5">${n.summary}…</div>` : ''}
        </a>`;
    }).join('');
  } catch (e) {
    // fallback 用 mock
    const fallback = stockNews[code] || [{ time: '今日', title: `新聞抓取失敗：${e.message}` }];
    box.innerHTML = fallback.map((n) => `
      <div class="news-item">
        <div class="time">${n.time}</div>
        <div class="title">${n.title}</div>
      </div>`).join('');
  }
}
