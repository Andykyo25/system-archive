// 技術診斷 — rule-based，從 K 線 + 三大法人推導訊號
// 輸出結構固定，給 stockPanel 的「技術診斷」區塊渲染
//
// 過擬合對策（Anti-overfitting design）：
//   1. Feature de-correlation：四面（trend/momentum/volPrice/chip）獨立評分，降低特徵重複加權
//   2. Regularization (L2-like)：四面投票一致性低 → winRate 收縮回 50（防單面主導）
//   3. Cross-validation：walkForwardAccuracy() 用過去 60 日做 5 日 forward 命中率
//   4. Penalty cap：罰分天花板 30 分，避免單一情境多重扣分
//   5. Economic constraints：流動性過濾 + 交易成本可行性檢查
//   6. WinRate clamp：[15, 78]，承認黑天鵝不可預測（不允許 100% 信心）

const avg = (arr) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1);

function std(arr) {
  if (!arr.length) return 0;
  const m = avg(arr);
  const v = avg(arr.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

// 乖離率 = (last - MA(period)) / MA(period) * 100
export function calcBias(closes, period = 20) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const slice = closes.slice(-period);
  const m = avg(slice);
  if (!m) return null;
  return ((closes[closes.length - 1] - m) / m) * 100;
}

// Wilder ATR(14) — 平均真實波幅
export function calcATR(k, period = 14) {
  if (!Array.isArray(k) || k.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < k.length; i++) {
    const a = k[i].high - k[i].low;
    const b = Math.abs(k[i].high - k[i - 1].close);
    const c = Math.abs(k[i].low - k[i - 1].close);
    tr.push(Math.max(a, b, c));
  }
  // 第一個 ATR 用前 period 個 TR 的平均，之後用 Wilder smoothing
  let atr = avg(tr.slice(0, period));
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return atr;
}

// 扣抵值 = period 日前的收盤價（MA 反轉判讀用）
export function calcMaDeduct(closes, period = 20) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  return closes[closes.length - period];
}

// 量能 Z-score：(last - mean) / std，>2 表示異常爆量
export function calcVolZ(vols, period = 20) {
  if (!Array.isArray(vols) || vols.length < period + 1) return null;
  const ref = vols.slice(-period - 1, -1); // 不含當天
  const m = avg(ref);
  const s = std(ref);
  if (!s) return null;
  return (vols[vols.length - 1] - m) / s;
}

function calcKD(k, period = 9) {
  if (k.length < period) return { k: 50, d: 50 };
  let kVal = 50, dVal = 50;
  for (let i = period - 1; i < k.length; i++) {
    const slice = k.slice(i - period + 1, i + 1);
    const high = Math.max(...slice.map((x) => x.high));
    const low = Math.min(...slice.map((x) => x.low));
    const rsv = high === low ? 50 : ((k[i].close - low) / (high - low)) * 100;
    kVal = (2 / 3) * kVal + (1 / 3) * rsv;
    dVal = (2 / 3) * dVal + (1 / 3) * kVal;
  }
  return { k: kVal, d: dVal };
}

function calcKDSeries(k, period = 9) {
  // 用於判斷死叉黃金叉
  let kVal = 50, dVal = 50;
  const out = [];
  for (let i = 0; i < k.length; i++) {
    if (i < period - 1) { out.push({ k: kVal, d: dVal }); continue; }
    const slice = k.slice(i - period + 1, i + 1);
    const high = Math.max(...slice.map((x) => x.high));
    const low = Math.min(...slice.map((x) => x.low));
    const rsv = high === low ? 50 : ((k[i].close - low) / (high - low)) * 100;
    kVal = (2 / 3) * kVal + (1 / 3) * rsv;
    dVal = (2 / 3) * dVal + (1 / 3) * kVal;
    out.push({ k: kVal, d: dVal });
  }
  return out;
}

function calcMACD(closes) {
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

function ma(k, n) {
  if (k.length < n) return null;
  return avg(k.slice(-n).map((d) => d.close));
}

// ─────────────── 多時間框架：日線 → 週線 resample ───────────────
// 用現有 90 日 K 線壓成 ~18 週，不另外打 API
export function resampleWeekly(k) {
  if (!Array.isArray(k) || k.length < 5) return [];
  const weeks = [];
  let bucket = null;
  for (const d of k) {
    if (!d.date || !Number.isFinite(d.close)) continue;
    const date = new Date(d.date);
    if (Number.isNaN(date.getTime())) continue;
    // 用 ISO 週 key（同週的 Monday 為 anchor）
    const day = date.getDay() === 0 ? 7 : date.getDay();
    const monday = new Date(date);
    monday.setDate(date.getDate() - day + 1);
    const wkKey = monday.toISOString().slice(0, 10);
    if (!bucket || bucket.weekKey !== wkKey) {
      if (bucket) weeks.push(bucket);
      bucket = { weekKey: wkKey, open: d.open, high: d.high, low: d.low, close: d.close, vol: d.vol || 0 };
    } else {
      if (d.high > bucket.high) bucket.high = d.high;
      if (d.low < bucket.low) bucket.low = d.low;
      bucket.close = d.close;
      bucket.vol += d.vol || 0;
    }
  }
  if (bucket) weeks.push(bucket);
  return weeks;
}

// ─────────────── 截面相對強度（vs 大盤） ───────────────
// 個股 N 日漲跌 - 大盤 N 日漲跌 = 超額報酬（%）
// benchmarkCloses 由 server 傳入（TAIEX 收盤陣列），daily-aligned
export function relativeStrength(closes, benchmarkCloses, period = 60) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  if (!Array.isArray(benchmarkCloses) || benchmarkCloses.length < period) return null;
  const stockNow = closes[closes.length - 1];
  const stockThen = closes[closes.length - period];
  const benchNow = benchmarkCloses[benchmarkCloses.length - 1];
  const benchThen = benchmarkCloses[benchmarkCloses.length - period];
  if (!stockThen || !benchThen) return null;
  const stockRet = ((stockNow - stockThen) / stockThen) * 100;
  const benchRet = ((benchNow - benchThen) / benchThen) * 100;
  return {
    stockReturn: +stockRet.toFixed(2),
    benchReturn: +benchRet.toFixed(2),
    rs: +(stockRet - benchRet).toFixed(2),  // 正 = 強過大盤
    period,
  };
}

// ─────────────── 輕量回測：sub-strategy 累積績效 ───────────────
// 假設「按系統訊號方向進場、HOLD 5 日後平倉」，扣除交易成本
// 不考慮滑價、不考慮資金管理（只看純訊號績效）
export function liteBacktest(k, { holdDays = 5, txCostPct = 1.17, lookback = 60 } = {}) {
  if (!Array.isArray(k) || k.length < 30 + holdDays) return null;
  const trades = [];
  const start = Math.max(25, k.length - lookback - holdDays);
  for (let i = start; i < k.length - holdDays; i++) {
    const dir = quickDirection(k.slice(0, i + 1));
    if (!dir || dir === 'neutral') continue;
    const entryPrice = k[i].close;
    const exitPrice = k[i + holdDays].close;
    if (!entryPrice || !exitPrice) continue;
    let ret = ((exitPrice - entryPrice) / entryPrice) * 100;
    if (dir === 'short') ret = -ret;
    ret -= txCostPct;  // 扣除雙趟成本（手續費 + 證交稅 + 滑價）
    trades.push({ ret });
  }
  if (trades.length < 5) return null;
  const wins = trades.filter((t) => t.ret > 0).length;
  const winRate = +((wins / trades.length) * 100).toFixed(1);
  const sumRet = trades.reduce((s, t) => s + t.ret, 0);
  const avgRet = sumRet / trades.length;
  // 累積報酬率（複利）
  let equity = 100;
  let peak = 100;
  let maxDD = 0;
  for (const t of trades) {
    equity *= 1 + t.ret / 100;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const cumulativeReturn = +(equity - 100).toFixed(2);
  // 簡易 Sharpe：假設 5 日 1 trade，一年 ~50 trades；無風險利率 0
  const variance = trades.reduce((s, t) => s + (t.ret - avgRet) ** 2, 0) / trades.length;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? +(avgRet / std * Math.sqrt(50)).toFixed(2) : null;
  return {
    trades: trades.length,
    winRate,
    cumulativeReturn,
    avgPerTrade: +avgRet.toFixed(2),
    maxDrawdown: +maxDD.toFixed(2),
    sharpe,
    holdDays,
    txCostPct,
  };
}

// ─────────────── Walk-forward 歷史驗證 ───────────────
// 設計：給定 K 線，從 lookback 天前每日跑一次「簡化方向判讀」，
// 對比 holdDays 後實際漲跌，計算命中率。等同 cross-validation。
// 簡化判讀：MA 排列 + RSI 區間 + 收盤站上/跌破 MA20 → 投票決定方向
function quickDirection(kSlice, taiexAlignedCloses = null) {
  if (!kSlice || kSlice.length < 25) return null;
  const last = kSlice[kSlice.length - 1];
  const closes = kSlice.map((d) => d.close);
  const ma5_v = avg(closes.slice(-5));
  const ma20_v = avg(closes.slice(-20));
  const rsi = calcRSI(closes, 14);
  let trendV = ma5_v > ma20_v ? 1 : -1;
  const priceV = last.close > ma20_v ? 1 : -1;
  const momV = rsi == null ? 0 : (rsi > 55 ? 1 : rsi < 45 ? -1 : 0);
  // ★ Cross-sectional RS：個股 60 日報酬 vs TAIEX 60 日報酬，差距明顯時 override trend 投票
  if (taiexAlignedCloses && taiexAlignedCloses.length >= 61 && closes.length >= 61) {
    const sRet = (last.close - closes[closes.length - 61]) / closes[closes.length - 61] * 100;
    const tRet = (taiexAlignedCloses[taiexAlignedCloses.length - 1] - taiexAlignedCloses[taiexAlignedCloses.length - 61])
                 / taiexAlignedCloses[taiexAlignedCloses.length - 61] * 100;
    const rs = sRet - tRet;
    if (rs > 7) trendV = 1;          // RS 強烈 → 趨勢必偏多
    else if (rs < -7) trendV = -1;   // RS 弱 → 趨勢必偏空
  }
  const sum = trendV + priceV + momV;
  return sum >= 2 ? 'long' : sum <= -2 ? 'short' : 'neutral';
}

// 每個策略模組（trend/momentum/volPrice）獨立投票 — 用於 walk-forward 個別命中率
// chip 模組需要歷史法人資料，FinMind 無法回填過去每天的法人快照，故 walk-forward 不含
// ★ 第二參數 taiexCloses 對齊到 kSlice 同 index → 計算當下 RS 並加進 trend vote（feature 升級）
function moduleVotesAtTime(kSlice, taiexAlignedCloses = null) {
  if (!kSlice || kSlice.length < 25) return null;
  const last = kSlice[kSlice.length - 1];
  const prev = kSlice[kSlice.length - 2];
  const closes = kSlice.map((d) => d.close);
  const vols = kSlice.map((d) => d.vol || 0);

  const ma5_v = avg(closes.slice(-5));
  const ma20_v = avg(closes.slice(-20));
  const ma60_v = closes.length >= 60 ? avg(closes.slice(-60)) : null;
  const above5 = last.close >= ma5_v;
  const above20 = last.close >= ma20_v;
  const above60 = ma60_v != null && last.close >= ma60_v;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Trend vote — MA 排列與位置 + ★ 截面相對強度（vs TAIEX）
  let trendVote = 0;
  if (above5)  trendVote += 0.2;  else trendVote -= 0.2;
  if (above20) trendVote += 0.3;  else trendVote -= 0.3;
  if (above60) trendVote += 0.2;  else trendVote -= 0.2;
  if (ma60_v != null) {
    if (ma5_v > ma20_v && ma20_v > ma60_v) trendVote += 0.3;
    else if (ma5_v < ma20_v && ma20_v < ma60_v) trendVote -= 0.3;
  }
  // ★ Cross-sectional：個股 60 日報酬 - TAIEX 60 日報酬
  if (taiexAlignedCloses && taiexAlignedCloses.length >= 61 && closes.length >= 61) {
    const stockRet60 = (last.close - closes[closes.length - 61]) / closes[closes.length - 61] * 100;
    const taiexRet60 = (taiexAlignedCloses[taiexAlignedCloses.length - 1] - taiexAlignedCloses[taiexAlignedCloses.length - 61])
                       / taiexAlignedCloses[taiexAlignedCloses.length - 61] * 100;
    const rs = stockRet60 - taiexRet60;
    if (rs > 7) trendVote += 0.25;
    else if (rs > 3) trendVote += 0.12;
    else if (rs < -7) trendVote -= 0.25;
    else if (rs < -3) trendVote -= 0.12;
  }
  trendVote = clamp(trendVote, -1, 1);

  // Momentum vote — RSI + 收盤方向
  const rsi = calcRSI(closes, 14);
  let momVote = 0;
  if (rsi != null) {
    if (rsi > 70) momVote -= 0.3;
    else if (rsi < 30) momVote += 0.3;
    else if (rsi > 55) momVote += 0.3;
    else if (rsi < 45) momVote -= 0.3;
  }
  if (last.close > prev.close) momVote += 0.2;
  else if (last.close < prev.close) momVote -= 0.2;
  momVote = clamp(momVote, -1, 1);

  // Volume-Price vote — 量比 + 量價配合
  const todayVol = last.vol || 0;
  const refVols = vols.slice(-21, -1).filter((v) => v > 0);
  const avgVol_v = refVols.length >= 5 ? avg(refVols) : null;
  let vpVote = 0;
  if (avgVol_v && todayVol > 0) {
    const ratio = todayVol / avgVol_v;
    const priceUp = last.close > prev.close;
    if (ratio > 1.8 && priceUp) vpVote += 0.6;
    else if (ratio > 1.8 && !priceUp) vpVote -= 0.6;
    else if (ratio > 1.3 && priceUp) vpVote += 0.3;
    else if (ratio < 0.7 && priceUp) vpVote -= 0.2;
    else if (ratio < 0.7 && !priceUp) vpVote += 0.1;  // 量縮止跌
  }
  vpVote = clamp(vpVote, -1, 1);

  return { trend: trendVote, momentum: momVote, volPrice: vpVote };
}

// Per-module walk-forward：對過去 N 日，分別檢查 trend/momentum/volPrice 三個 view
// 各自的方向預測是否與 N 日後實際漲跌方向一致 → 算個別勝率
export function perModuleWalkForward(k, { lookback = 60, holdDays = 5, threshold = 0.3, taiexCloses = null } = {}) {
  if (!Array.isArray(k) || k.length < 30 + holdDays) return null;
  const stats = {
    trend:    { hits: 0, total: 0 },
    momentum: { hits: 0, total: 0 },
    volPrice: { hits: 0, total: 0 },
  };
  const start = Math.max(25, k.length - lookback - holdDays);
  // 對齊 taiex 與 k 的「最後一筆 = 同一天」假設下，前 i+1 筆與前 i+1 筆 TAIEX 對應
  // 若 taiex 長度不同，截到最近的同長度
  const taiexAligned = taiexCloses && taiexCloses.length >= k.length
    ? taiexCloses.slice(taiexCloses.length - k.length)
    : null;
  for (let i = start; i < k.length - holdDays; i++) {
    const votes = moduleVotesAtTime(
      k.slice(0, i + 1),
      taiexAligned ? taiexAligned.slice(0, i + 1) : null,
    );
    if (!votes) continue;
    const ret = (k[i + holdDays].close - k[i].close) / k[i].close;
    if (ret === 0) continue;
    const expectedSign = ret > 0 ? 1 : -1;
    Object.entries(votes).forEach(([mod, v]) => {
      // 只計票「明確意見」的時刻（避免 0 票被算成「答錯」）
      if (Math.abs(v) >= threshold) {
        stats[mod].total++;
        if ((v > 0 ? 1 : -1) === expectedSign) stats[mod].hits++;
      }
    });
  }
  const out = {};
  Object.entries(stats).forEach(([mod, s]) => {
    out[mod] = {
      hitRate: s.total >= 5 ? +(s.hits / s.total * 100).toFixed(1) : null,
      samples: s.total,
    };
  });
  return out;
}

// 依各模組命中率動態調整權重（chip 沒 walk-forward 樣本，用 baseline 不調）
export function computeDynamicWeights(moduleAccuracy) {
  const base = { trend: 0.30, momentum: 0.25, volPrice: 0.20, chip: 0.25 };
  if (!moduleAccuracy) return { weights: base, adjusted: false };
  // 評分：≥60% × 1.2、50-60% × 1.0、40-50% × 0.8、<40% × 0.6（強烈降權）
  const factor = (acc) => {
    const h = acc?.hitRate;
    if (h == null) return 1.0;
    if (h >= 60) return 1.2;
    if (h >= 50) return 1.0;
    if (h >= 40) return 0.8;
    return 0.6;
  };
  const scaled = {
    trend:    base.trend    * factor(moduleAccuracy.trend),
    momentum: base.momentum * factor(moduleAccuracy.momentum),
    volPrice: base.volPrice * factor(moduleAccuracy.volPrice),
    chip:     base.chip,  // 無 walk-forward 樣本
  };
  const sum = Object.values(scaled).reduce((s, v) => s + v, 0);
  const weights = Object.fromEntries(Object.entries(scaled).map(([k, v]) => [k, +(v / sum).toFixed(3)]));
  // 與 base 比較，是否真的有調整
  const adjusted = Object.keys(base).some((k) => Math.abs(weights[k] - base[k]) > 0.005);
  return { weights, adjusted, factors: {
    trend: +factor(moduleAccuracy.trend).toFixed(2),
    momentum: +factor(moduleAccuracy.momentum).toFixed(2),
    volPrice: +factor(moduleAccuracy.volPrice).toFixed(2),
    chip: 1.0,
  }};
}

// ★ taiexCloses 可選：傳入時跑 feature-augmented quickDirection；不傳則跑 legacy 邏輯
// 若只想要 ROI 對照：呼叫兩次（含/不含 taiexCloses）即可比較 feature 升級的命中率差距
export function walkForwardAccuracy(k, { lookback = 60, holdDays = 5, taiexCloses = null } = {}) {
  if (!Array.isArray(k) || k.length < 30 + holdDays) return null;
  let correct = 0, total = 0, longHits = 0, longTotal = 0, shortHits = 0, shortTotal = 0;
  const start = Math.max(25, k.length - lookback - holdDays);
  const taiexAligned = taiexCloses && taiexCloses.length >= k.length
    ? taiexCloses.slice(taiexCloses.length - k.length)
    : null;
  for (let i = start; i < k.length - holdDays; i++) {
    const dir = quickDirection(
      k.slice(0, i + 1),
      taiexAligned ? taiexAligned.slice(0, i + 1) : null,
    );
    if (!dir || dir === 'neutral') continue;
    const ret = (k[i + holdDays].close - k[i].close) / k[i].close;
    const hit = (dir === 'long' && ret > 0) || (dir === 'short' && ret < 0);
    if (hit) correct++;
    total++;
    if (dir === 'long') { longTotal++; if (hit) longHits++; }
    else { shortTotal++; if (hit) shortHits++; }
  }
  if (total < 5) return null;
  return {
    hitRate: +(correct / total * 100).toFixed(1),
    samples: total,
    longHitRate: longTotal ? +(longHits / longTotal * 100).toFixed(1) : null,
    shortHitRate: shortTotal ? +(shortHits / shortTotal * 100).toFixed(1) : null,
    holdDays,
    featureAugmented: !!taiexAligned,
  };
}

// ─────────────── Feature Engineering ───────────────
// 統一輸出 ML-ready feature vector。給 diagnose 評分增強用，也給未來 ML 直接訓練。
export function extractFeatures(args) {
  const {
    closes = [], vols = [], k = [],
    ma5, ma20, ma60,
    last, prev = null, atr14, bias20, rsi14,
    kdK, kdD,
    foreign, trust, dealer,
    distToHigh, distToLow,
    marketContext = null,
    industryStats = null,
    fundamentals = null,
  } = args;
  if (!last || !closes.length) return null;

  // ─ Lag / delta ─
  const rsiLag5 = closes.length >= 19 ? calcRSI(closes.slice(0, -5), 14) : null;
  const rsiChange5d = rsi14 != null && rsiLag5 != null ? +(rsi14 - rsiLag5).toFixed(1) : null;

  // ─ 報酬 ─
  const ret = (n) => closes.length >= n + 1 && closes[closes.length - 1 - n] > 0
    ? +(((last.close - closes[closes.length - 1 - n]) / closes[closes.length - 1 - n]) * 100).toFixed(2)
    : null;
  const return_1d = ret(1);
  const return_5d = ret(5);
  const return_20d = ret(20);
  const return_60d = ret(60);

  // ─ 波動度 ─
  const atr_pct = atr14 != null && last.close > 0 ? +((atr14 / last.close) * 100).toFixed(2) : null;
  let realized_vol_20d = null;
  if (closes.length >= 21) {
    const rets = [];
    for (let i = closes.length - 20; i < closes.length; i++) {
      if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
    }
    if (rets.length >= 10) {
      const m = avg(rets);
      const v = avg(rets.map((x) => (x - m) ** 2));
      realized_vol_20d = +(Math.sqrt(v) * Math.sqrt(252) * 100).toFixed(1);
    }
  }

  // ─ 量能趨勢 ─
  let vol_trend_5d = null;
  if (vols.length >= 11) {
    const recent5 = vols.slice(-5).filter((v) => v > 0);
    const prior5 = vols.slice(-10, -5).filter((v) => v > 0);
    if (recent5.length && prior5.length) {
      const r = avg(recent5);
      const p = avg(prior5);
      vol_trend_5d = p > 0 ? +(r / p).toFixed(2) : null;
    }
  }

  // ─ 截面（vs TAIEX）─
  let rs_vs_taiex_60d = null;
  if (return_60d != null && marketContext?.taiex_return_60d != null) {
    rs_vs_taiex_60d = +(return_60d - marketContext.taiex_return_60d).toFixed(2);
  }
  let rs_vs_taiex_5d = null;
  if (return_5d != null && marketContext?.taiex_return_5d != null) {
    rs_vs_taiex_5d = +(return_5d - marketContext.taiex_return_5d).toFixed(2);
  }

  // ★ 產業 RS rank — 個股在自己產業中的 60 日報酬百分位
  let industry_rs_rank = null;     // 0-1，越高越強
  let industry_rs_diff = null;     // 個股 60d ret - 產業均值
  let industry_label = null;
  if (industryStats?.peers && industryStats.peers.length >= 3 && return_60d != null) {
    const peerRets = industryStats.peers.map((p) => p.ret60d);
    const mean = peerRets.reduce((s, x) => s + x, 0) / peerRets.length;
    industry_rs_diff = +(return_60d - mean).toFixed(2);
    const lowerCount = peerRets.filter((r) => r < return_60d).length;
    industry_rs_rank = +(lowerCount / (peerRets.length - 1 || 1)).toFixed(2);
    industry_label = industryStats.industry;
  }

  // ★ 量能異常（今日量 vs 60 日均量）
  let turnover_spike_60d = null;
  if (vols.length >= 60) {
    const recent60 = vols.slice(-60).filter((v) => v > 0);
    if (recent60.length >= 30) {
      const a = recent60.reduce((s, v) => s + v, 0) / recent60.length;
      if (a > 0 && (last.vol || 0) > 0) turnover_spike_60d = +((last.vol || 0) / a).toFixed(2);
    }
  }

  // ★ Gap 分析（開盤跳空 + 實體比例）
  let gap_open_pct = null;
  let body_ratio = null;
  let upper_wick_pct = null;
  let lower_wick_pct = null;
  if (prev?.close > 0 && last.open != null) {
    gap_open_pct = +(((last.open - prev.close) / prev.close) * 100).toFixed(2);
  }
  const range = last.high - last.low;
  if (range > 0) {
    const body = Math.abs(last.close - last.open);
    body_ratio = +(body / range).toFixed(2);
    const top = Math.max(last.close, last.open);
    const bot = Math.min(last.close, last.open);
    upper_wick_pct = +(((last.high - top) / range) * 100).toFixed(1);
    lower_wick_pct = +(((bot - last.low) / range) * 100).toFixed(1);
  }

  // ★ 52 週相對位置
  let price_52w_position = null;
  let dist_to_52w_high_pct = null;
  let dist_to_52w_low_pct = null;
  if (closes.length >= 252) {
    const w52 = closes.slice(-252);
    const max252 = Math.max(...w52);
    const min252 = Math.min(...w52);
    if (max252 > min252) {
      price_52w_position = +((last.close - min252) / (max252 - min252)).toFixed(3);
      dist_to_52w_high_pct = +(((max252 - last.close) / last.close) * 100).toFixed(2);
      dist_to_52w_low_pct = +(((last.close - min252) / last.close) * 100).toFixed(2);
    }
  } else if (closes.length >= 60) {
    // 樣本不足 52 週時 fallback：用全部歷史當分母
    const all = closes;
    const maxA = Math.max(...all);
    const minA = Math.min(...all);
    if (maxA > minA) price_52w_position = +((last.close - minA) / (maxA - minA)).toFixed(3);
  }

  // ★ 基本面 features
  const fund_pe = fundamentals?.pe ?? null;
  const fund_pb = fundamentals?.pb ?? null;
  const fund_roe = fundamentals?.roe ?? null;
  const fund_div_yield = fundamentals?.divYield ?? null;
  const fund_eps_ttm = fundamentals?.epsTTM ?? null;
  const fund_gpm = fundamentals?.gpm ?? null;

  return {
    // 既有
    bias20: bias20 != null ? +bias20.toFixed(2) : null,
    rsi14: rsi14 != null ? +rsi14.toFixed(1) : null,
    kd_k: kdK != null ? +kdK.toFixed(1) : null,
    kd_d: kdD != null ? +kdD.toFixed(1) : null,
    kd_diff: kdK != null && kdD != null ? +(kdK - kdD).toFixed(1) : null,
    ma5_above_ma20: ma5 != null && ma20 != null ? (ma5 > ma20 ? 1 : 0) : null,
    ma20_above_ma60: ma20 != null && ma60 != null ? (ma20 > ma60 ? 1 : 0) : null,
    foreign_3d: foreign,
    trust_3d: trust,
    dealer_3d: dealer,
    dist_to_high_pct: distToHigh != null ? +distToHigh.toFixed(2) : null,
    dist_to_low_pct: distToLow != null ? +distToLow.toFixed(2) : null,
    // 新增
    return_1d, return_5d, return_20d, return_60d,
    rsi_lag5: rsiLag5 != null ? +rsiLag5.toFixed(1) : null,
    rsi_change_5d: rsiChange5d,
    atr_pct, realized_vol_20d,
    vol_trend_5d,
    // 截面
    rs_vs_taiex_60d, rs_vs_taiex_5d,
    // ★ 產業 RS
    industry_rs_rank, industry_rs_diff, industry_label,
    // ★ 量能異常
    turnover_spike_60d,
    // ★ Gap / 微結構
    gap_open_pct, body_ratio, upper_wick_pct, lower_wick_pct,
    // ★ 52 週位置
    price_52w_position, dist_to_52w_high_pct, dist_to_52w_low_pct,
    // ★ 基本面
    fund_pe, fund_pb, fund_roe, fund_div_yield, fund_eps_ttm, fund_gpm,
    // 大盤狀態
    taiex_trend: marketContext?.taiex_trend ?? null,
    taiex_vol_20d: marketContext?.taiex_vol_20d ?? null,
    taiex_ma20_above_ma60: marketContext?.taiex_ma20_above_ma60 ?? null,
    taiex_return_60d: marketContext?.taiex_return_60d ?? null,
    regime_label: marketContext?.regime_label ?? null,
  };
}

// 把 feature 轉成 baseScore 的調整量（contribution 透明化，便於追蹤）
// 回傳：{ adjustment: 累計分數調整, contributions: { rs_vs_taiex: +4, regime: -5, ... } }
export function applyFeatureContributions(features) {
  if (!features) return { adjustment: 0, contributions: {} };
  const c = {};
  let adj = 0;

  // 1. 截面相對強度（vs 大盤）— 60 日 RS
  if (features.rs_vs_taiex_60d != null) {
    let v = 0;
    if (features.rs_vs_taiex_60d > 15)      v = 6;   // 強勢領漲股
    else if (features.rs_vs_taiex_60d > 7)  v = 4;
    else if (features.rs_vs_taiex_60d > 3)  v = 2;
    else if (features.rs_vs_taiex_60d < -15) v = -6; // 弱勢領跌
    else if (features.rs_vs_taiex_60d < -7)  v = -4;
    else if (features.rs_vs_taiex_60d < -3)  v = -2;
    if (v !== 0) { c.rs_vs_taiex_60d = v; adj += v; }
  }

  // 2. 大盤 regime（多頭加分、空頭重扣，不對稱因為熊市殺力強）
  if (features.taiex_trend === 1) {
    c.regime = 3;  adj += 3;
  } else if (features.taiex_trend === -1) {
    c.regime = -5; adj -= 5;
  }

  // 3. RSI 動能（5 日 delta）— 健康上行/下行
  if (features.rsi_change_5d != null && features.rsi14 != null) {
    if (features.rsi_change_5d > 15 && features.rsi14 < 65 && features.rsi14 > 35) {
      c.rsi_momentum = 3; adj += 3;
    } else if (features.rsi_change_5d < -15 && features.rsi14 < 65 && features.rsi14 > 35) {
      c.rsi_momentum = -3; adj -= 3;
    }
  }

  // 4. 量能趨勢
  if (features.vol_trend_5d != null) {
    if (features.vol_trend_5d > 1.5)      { c.vol_trend = 2;  adj += 2; }
    else if (features.vol_trend_5d < 0.5) { c.vol_trend = -2; adj -= 2; }
  }

  // 5. RS 短期反轉（5 日 RS 突然轉強，大盤跌但個股強）
  if (features.rs_vs_taiex_5d != null) {
    if (features.rs_vs_taiex_5d > 4 && features.taiex_trend !== 1) {
      c.rs_short_reversal = 2; adj += 2;
    }
  }

  // ★ 6. 產業 RS rank（最重要：在強勢產業挑落後股是大坑）
  if (features.industry_rs_rank != null) {
    let v = 0;
    if (features.industry_rs_rank > 0.85) v = 5;       // 產業前 15%
    else if (features.industry_rs_rank > 0.65) v = 3;
    else if (features.industry_rs_rank < 0.15) v = -5; // 產業後 15%
    else if (features.industry_rs_rank < 0.35) v = -3;
    if (v !== 0) { c.industry_rs_rank = v; adj += v; }
  }

  // ★ 7. 量能異常（爆量帶價漲）
  if (features.turnover_spike_60d != null) {
    const spike = features.turnover_spike_60d;
    const priceUp = features.return_1d != null && features.return_1d > 0;
    if (spike > 3 && priceUp) { c.turnover_spike = 4; adj += 4; }      // 爆量大漲
    else if (spike > 3 && !priceUp) { c.turnover_spike = -3; adj -= 3; } // 爆量收黑
    else if (spike > 2 && priceUp) { c.turnover_spike = 2; adj += 2; }
  }

  // ★ 8. Gap 分析
  if (features.gap_open_pct != null) {
    const gap = features.gap_open_pct;
    if (gap > 2 && features.body_ratio > 0.5 && features.return_1d > 0) {
      c.gap_strong = 3; adj += 3;     // 跳空帶量收實體大紅
    } else if (gap < -2 && features.return_1d < 0) {
      c.gap_weak = -3; adj -= 3;      // 跳空殺低收黑
    }
  }

  // ★ 10. 強勢突破組合（解保守問題）— 漲停 / 大紅棒帶量必須給足分
  // 條件：當日漲幅 > 5% + 量爆 2x+ + 實體大 + 收盤接近最高（不是長上影）
  if (features.return_1d != null && features.turnover_spike_60d != null && features.body_ratio != null) {
    const isLimit = features.return_1d >= 9;        // 漲停
    const isBigUp = features.return_1d >= 5;        // 大紅棒
    const isVolBurst = features.turnover_spike_60d > 2;
    const isCleanBody = features.body_ratio > 0.6;
    const isClosingHigh = features.upper_wick_pct != null && features.upper_wick_pct < 20;

    if (isLimit && isVolBurst) {
      c.limit_up_breakout = 12; adj += 12;          // 漲停加 12 分（最強訊號）
    } else if (isBigUp && isVolBurst && isCleanBody && isClosingHigh) {
      c.strong_breakout = 8; adj += 8;              // 大紅帶量收最高
    } else if (isBigUp && isVolBurst) {
      c.medium_breakout = 5; adj += 5;
    }
  }

  // ★ 9. 52 週位置（接近高點 + RS 強 = momentum 經典訊號）
  if (features.price_52w_position != null) {
    if (features.price_52w_position > 0.9 && features.industry_rs_rank > 0.7) {
      c.position_52w = 3; adj += 3;   // 52 週高 + 產業領頭
    } else if (features.price_52w_position < 0.1) {
      c.position_52w = -2; adj -= 2;  // 52 週低，弱
    }
  }

  return { adjustment: adj, contributions: c };
}

// Wilder RSI(14)：股票圈標準算法
export function calcRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function diagnose(k, inst = [], opts = {}) {
  if (!k || k.length < 5) return null;
  const last = k[k.length - 1];
  const prev = k[k.length - 2];
  const { sharesOutstanding, marketContext = null, industryStats = null, fundamentals = null } = opts;

  const ma5  = ma(k, 5);
  const ma20 = ma(k, 20);
  const ma60 = ma(k, 60);
  const aboveMa5  = ma5  != null && last.close >= ma5;
  const aboveMa20 = ma20 != null && last.close >= ma20;
  const aboveMa60 = ma60 != null && last.close >= ma60;

  // ── 預先計算所有指標（避免 TDZ）──
  const closes = k.map((d) => d.close);
  const vols = k.map((d) => d.vol || 0);
  const bias20 = calcBias(closes, 20);
  const atr14 = calcATR(k, 14);
  const maDeduct20 = calcMaDeduct(closes, 20);
  const volZ = calcVolZ(vols, 20);
  const rsi14 = calcRSI(closes, 14);
  const rsiPrev = calcRSI(closes.slice(0, -1), 14);

  // ── 多時間框架（週線）：用同一份 K 線壓成週線，無額外網路 ──
  const weekly = resampleWeekly(k);
  const weeklyMa4 = weekly.length >= 4 ? avg(weekly.slice(-4).map((w) => w.close)) : null;
  const weeklyClose = weekly.length ? weekly[weekly.length - 1].close : null;
  const weeklyTrend = (weeklyClose != null && weeklyMa4 != null)
    ? (weeklyClose > weeklyMa4 ? 'up' : weeklyClose < weeklyMa4 ? 'down' : 'flat')
    : null;

  // ── 截面相對強度：vs benchmarkCloses（TAIEX，由 server 傳入）──
  const rs = relativeStrength(closes, opts.benchmarkCloses, 60);

  // ── 輕量回測：用過去 60 日訊號模擬累積績效 ──
  const backtest = liteBacktest(k, { holdDays: 5, lookback: 60 });

  // 趨勢判讀
  let trend, trendNote;
  if (aboveMa5 && aboveMa20 && aboveMa60 && ma5 > ma20 && ma20 > ma60) {
    trend = '多頭排列'; trendNote = '5/20/60 MA 由上而下，多頭格局健康';
  } else if (!aboveMa5 && !aboveMa20 && !aboveMa60) {
    trend = '空頭排列'; trendNote = '股價跌破三均線，弱勢';
  } else if (aboveMa20) {
    trend = '中期偏多'; trendNote = '股價站上 20MA，中期趨勢偏多';
  } else {
    trend = '中期偏空'; trendNote = '股價跌破 20MA，留意支撐';
  }

  // 短線
  const shortTrend = aboveMa5 ? '短線偏多' : '短線轉弱';

  // KD
  const kdSeries = calcKDSeries(k);
  const cur = kdSeries[kdSeries.length - 1];
  const prevKD = kdSeries[kdSeries.length - 2] || cur;
  let kdSignal, kdLevel;
  if (cur.k > 80 && cur.d > 80) kdLevel = '高檔鈍化';
  else if (cur.k < 20 && cur.d < 20) kdLevel = '低檔鈍化';
  else if (cur.k > 50) kdLevel = '中性偏多';
  else kdLevel = '中性偏空';

  if (prevKD.k <= prevKD.d && cur.k > cur.d) kdSignal = '黃金交叉';
  else if (prevKD.k >= prevKD.d && cur.k < cur.d) kdSignal = '死亡交叉';
  else if (cur.k > cur.d) kdSignal = '多頭排列';
  else kdSignal = '空頭排列';

  // MACD
  const macd = calcMACD(k.map((d) => d.close));
  const oscLast = macd.osc[macd.osc.length - 1];
  const oscPrev = macd.osc[macd.osc.length - 2] || 0;
  const difLast = macd.dif[macd.dif.length - 1];
  const demLast = macd.dem[macd.dem.length - 1];
  let macdSignal;
  if (difLast > demLast && oscLast > oscPrev) macdSignal = '多頭擴張';
  else if (difLast > demLast && oscLast < oscPrev) macdSignal = '多頭縮減';
  else if (difLast < demLast && oscLast < oscPrev) macdSignal = '空頭擴張';
  else macdSignal = '空頭縮減';

  // 量能 — 改為「對近 20 日均量」做比較（更接近專業判讀的「爆量」標準）
  const todayVol = last.vol || 0;
  const volMissing = todayVol <= 0;
  // 排除今日，取前 20 日均量（資料不足則退到 5 日）
  const refVols = k.slice(-21, -1).map((d) => d.vol || 0).filter((v) => v > 0);
  const ref5 = k.slice(-6, -1).map((d) => d.vol || 0).filter((v) => v > 0);
  const avgVol = (refVols.length >= 10 ? avg(refVols) : (ref5.length ? avg(ref5) : 1)) || 1;
  const volRatio = volMissing ? 1 : todayVol / avgVol;
  let volSignal;
  if (volMissing) volSignal = '量能待更新';
  else if (volRatio > 2.0) volSignal = '量能爆發';   // 200% 均量
  else if (volRatio > 1.3) volSignal = '量能放大';
  else if (volRatio < 0.7) volSignal = '量能萎縮';
  else volSignal = '量能持平';

  // 量價關係 — 量能未更新時不做判讀
  const priceUp = last.close > prev.close;
  const volUp = !volMissing && todayVol > (prev.vol || 0);
  let priceVol;
  if (volMissing) priceVol = '量能未到，量價判讀延後';
  else if (priceUp && volUp) priceVol = '價漲量增';
  else if (priceUp && !volUp) priceVol = '價漲量縮（背離）';
  else if (!priceUp && volUp) priceVol = '價跌量增（出貨疑慮）';
  else priceVol = '價跌量縮（止跌）';

  // 三大法人 — 取近 3 日所有 row（每天每法人各一列）
  const recentDates = [...new Set((inst || []).map((r) => r.date))].sort().slice(-3);
  const recentInst = (inst || []).filter((r) => recentDates.includes(r.date));
  const sumByName = (kw) => recentInst
    .filter((r) => (r.name || '').includes(kw))
    .reduce((s, r) => s + ((+r.buy || 0) - (+r.sell || 0)), 0);
  const foreign = sumByName('外資') || sumByName('Foreign');
  const trust   = sumByName('投信');
  const dealer  = sumByName('自營');
  const biasLabel = (n) => n > 0 ? '偏買超' : n < 0 ? '偏賣超' : '中性';
  const totalInst = foreign + trust + dealer;

  // 投信佔股本比：近 3 日投信淨買股數 / 流通股數 × 100
  // 若 inst row 帶有 trustPctOfCap（server-side 已 join），優先採用累加值
  let trustPctOfCap = null;
  const rowsWithPct = recentInst.filter((r) => r.name?.includes('投信') && Number.isFinite(+r.trustPctOfCap));
  if (rowsWithPct.length) {
    trustPctOfCap = rowsWithPct.reduce((s, r) => s + (+r.trustPctOfCap || 0), 0);
  } else if (sharesOutstanding && sharesOutstanding > 0) {
    trustPctOfCap = (trust / sharesOutstanding) * 100;
  }
  const mainForce =
    foreign > 0 && trust > 0 ? '外資+投信同向買超' :
    foreign < 0 && trust < 0 ? '外資+投信同向賣超' :
    Math.abs(totalInst) < 1000 ? '法人態度分歧' : '法人偏 ' + (totalInst > 0 ? '買' : '賣');

  // 高低點與支撐
  const high60 = Math.max(...k.slice(-60).map((d) => d.high));
  const low60 = Math.min(...k.slice(-60).map((d) => d.low));
  const distToHigh = ((high60 - last.close) / last.close) * 100;
  const distToLow  = ((last.close - low60) / last.close) * 100;

  // 近期訊號 — 加上交叉驗證（避免單一條件誤判）
  // 規則：訊號需「主條件 + 至少一個輔助條件」才掛上，降低偽訊號率
  const signals = [];

  // KD 高檔死叉：需 KD 在 70+ 且收盤跌破 5MA（否則只是技術噪音）
  if (kdSignal === '死亡交叉' && cur.k > 70 && (ma5 == null || last.close < ma5)) {
    signals.push({ tag: '警示', text: `KD 高檔死叉 + 跌破 5MA — 短線回測風險（K=${cur.k.toFixed(0)}）` });
  }
  // KD 低檔黃金叉：需 KD 在 30- 且收盤上彎（last > prev）
  if (kdSignal === '黃金交叉' && cur.k < 30 && priceUp) {
    signals.push({ tag: '機會', text: `KD 低檔黃金叉 + 收紅 — 短線可期反彈（K=${cur.k.toFixed(0)}）` });
  }
  // 帶量突破：量爆 + 價漲 + 收盤站上 5MA
  if (volSignal === '量能爆發' && priceUp && ma5 != null && last.close > ma5) {
    signals.push({ tag: '注意', text: `帶量突破（量 ${volRatio.toFixed(1)}x 均量）+ 站上 5MA — 主力進場跡象` });
  }
  // 高檔爆量收黑：需 接近 60 日高 OR Bias > 5（單純收黑不足以判出貨）
  if (volSignal === '量能爆發' && !priceUp && (distToHigh < 5 || (bias20 != null && bias20 > 5))) {
    signals.push({ tag: '警示', text: `高檔爆量收黑（量 ${volRatio.toFixed(1)}x）— 主力調節跡象` });
  }
  // 價量背離：價漲量縮 + 距離 60 日高 < 5%
  if (priceVol === '價漲量縮（背離）' && distToHigh < 5) {
    signals.push({ tag: '警示', text: '高檔價量背離 — 上漲動能轉弱、留意拉回' });
  }
  // 接近 60 日高：需 量能放大或爆發 才稱「突破關鍵」
  if (distToHigh < 3 && (volSignal === '量能放大' || volSignal === '量能爆發')) {
    signals.push({ tag: '注意', text: `逼近 60 日高 ${high60.toFixed(2)} + 量能配合 — 突破或回落關鍵` });
  } else if (distToHigh < 3) {
    signals.push({ tag: '中性', text: `逼近 60 日高 ${high60.toFixed(2)}（量能未放大）— 觀察是否假突破` });
  }
  // 接近 60 日低：需 收紅 或 KD < 20 才稱「支撐有效」
  if (distToLow < 3 && (priceUp || cur.k < 20)) {
    signals.push({ tag: '機會', text: `逼近 60 日低 ${low60.toFixed(2)} + 止跌訊號 — 支撐測試成功率較高` });
  } else if (distToLow < 3) {
    signals.push({ tag: '警示', text: `逼近 60 日低 ${low60.toFixed(2)}（仍弱勢）— 留意破底` });
  }
  // 三大法人同步買超：保留高信賴訊號
  if (foreign > 0 && trust > 0 && dealer > 0) {
    signals.push({ tag: '機會', text: `三大法人同步買超（外+${(foreign / 1000).toFixed(0)}張、投+${(trust / 1000).toFixed(0)}張）— 多方共識` });
  }
  // 外資+投信同向賣超：搭配股價跌破 20MA 才是真撤離
  if (foreign < 0 && trust < 0 && !aboveMa20) {
    signals.push({ tag: '警示', text: '外資+投信同步賣超 + 跌破 20MA — 主力撤離' });
  }
  // 軋空候選：需 KD 黃金叉 / 多頭排列 且 法人偏買，避免單純技術反彈誤判
  if (foreign > 0 && (kdSignal === '黃金交叉' || kdSignal === '多頭排列') && priceUp && volSignal !== '量能萎縮') {
    signals.push({ tag: '機會', text: '外資買超 + KD 多方 + 帶量上攻 — 短線追擊優選' });
  }

  // RSI signals 將在後面計算完 rsi14 後才補進；空訊號 fallback 也順延到最後

  // 整體結論
  const bullishPts =
    (aboveMa20 ? 1 : 0) +
    (kdSignal === '黃金交叉' || kdSignal === '多頭排列' ? 1 : 0) +
    (macdSignal.startsWith('多頭') ? 1 : 0) +
    (priceUp && volUp ? 1 : 0) +
    (totalInst > 0 ? 1 : 0);
  const bearishPts =
    (!aboveMa20 ? 1 : 0) +
    (kdSignal === '死亡交叉' || kdSignal === '空頭排列' ? 1 : 0) +
    (macdSignal.startsWith('空頭') ? 1 : 0) +
    (!priceUp && volUp ? 1 : 0) +
    (totalInst < 0 ? 1 : 0);

  // RSI 補進 signals（跟其他指標交叉驗證）
  if (rsi14 != null) {
    if (rsi14 > 80) signals.unshift({ tag: '警示', text: `RSI 過熱（${rsi14.toFixed(1)}）— 高檔追價風險增加` });
    else if (rsi14 < 20) signals.unshift({ tag: '機會', text: `RSI 超賣（${rsi14.toFixed(1)}）— 短線反彈機會` });
    // RSI 背離（價接近新高但 RSI 走弱）
    if (distToHigh < 2 && rsiPrev != null && rsi14 < rsiPrev && rsi14 < 70) {
      signals.push({ tag: '警示', text: `價接近 60 日高但 RSI 走弱 — 動能背離` });
    }
  }
  // 訊號為空時補一個中性 fallback
  if (!signals.length) signals.push({ tag: '中性', text: '目前無強烈買賣訊號（多項指標未同步）' });
  const turnoverRate = (sharesOutstanding && sharesOutstanding > 0 && last.vol)
    ? ((last.vol * 1000) / sharesOutstanding) * 100   // vol 為「張」，× 1000 換成股
    : null;

  const score0 = bullishPts - bearishPts; // -5 ~ +5（保留原 score 給 overall 判讀）
  const score = score0;

  // ─────── 勝率 v2：四面加權平均 + 風險懲罰 ───────
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // 1. 趨勢面 (0-100)：MA 排列 + Bias 偏離（對稱化）
  let trendScore = 50;
  if (aboveMa5)  trendScore += 5; else trendScore -= 5;
  if (aboveMa20) trendScore += 10; else trendScore -= 10;
  if (aboveMa60) trendScore += 10; else trendScore -= 10;
  if (ma5 != null && ma20 != null && ma60 != null) {
    if (ma5 > ma20 && ma20 > ma60) trendScore += 18;        // 多頭排列
    else if (ma5 < ma20 && ma20 < ma60) trendScore -= 18;   // 空頭排列（對稱）
  }
  if (bias20 != null) {
    if (bias20 > 10) trendScore -= 12;        // 過熱
    else if (bias20 > 5) trendScore -= 4;
    else if (bias20 < -10) trendScore += 12;  // 超跌反彈（對稱）
    else if (bias20 < -5) trendScore += 4;
  }
  // ── 截面相對強度（vs TAIEX 60 日）──
  if (rs && rs.rs != null) {
    if (rs.rs > 15) trendScore += 10;        // 強勢領漲
    else if (rs.rs > 5) trendScore += 5;
    else if (rs.rs < -15) trendScore -= 10;  // 弱勢落後
    else if (rs.rs < -5) trendScore -= 5;
  }
  // ── 週線趨勢加分（同向加 8、反向不加減）— 真正的扣分留給後面共振檢查 ──
  if (weeklyTrend === 'up') trendScore += 6;
  else if (weeklyTrend === 'down') trendScore -= 6;
  trendScore = clamp(trendScore, 0, 100);

  // 2. 動能面 (0-100)：KD 事件 + MACD 趨勢 + RSI（多空對稱）
  let momentumScore = 50;
  // KD 事件 — 對稱權重
  if (kdSignal === '黃金交叉') momentumScore += 20;
  else if (kdSignal === '多頭排列') momentumScore += 8;
  else if (kdSignal === '死亡交叉') momentumScore -= 20;   // 由 -25 → -20，對稱化
  else if (kdSignal === '空頭排列') momentumScore -= 8;    // 由 -10 → -8
  if (kdLevel === '高檔鈍化') momentumScore -= 12;
  else if (kdLevel === '低檔鈍化') momentumScore += 12;
  // 黃金交叉 + 低檔（K<30）= 強反轉訊號，雙重加分
  if (kdSignal === '黃金交叉' && cur.k < 30) momentumScore += 8;
  if (kdSignal === '死亡交叉' && cur.k > 70) momentumScore -= 8;
  // MACD 對稱化
  if (macdSignal === '多頭擴張') momentumScore += 15;
  else if (macdSignal === '多頭縮減') momentumScore += 3;
  else if (macdSignal === '空頭擴張') momentumScore -= 15;
  else if (macdSignal === '空頭縮減') momentumScore -= 3;
  // RSI(14) — 真實計算，整合到動能面
  if (rsi14 != null) {
    if (rsi14 > 80) momentumScore -= 12;          // 過熱
    else if (rsi14 > 70) momentumScore -= 5;      // 偏熱
    else if (rsi14 < 20) momentumScore += 12;     // 超賣反彈機會
    else if (rsi14 < 30) momentumScore += 5;
    else if (rsi14 >= 50 && rsi14 <= 65) momentumScore += 4;  // 健康偏多
    // RSI 上彎反轉訊號（從低檔上來）
    if (rsiPrev != null && rsi14 > rsiPrev && rsiPrev < 40 && rsi14 >= 40) momentumScore += 5;
    // RSI 下彎反轉（從高檔下來）
    if (rsiPrev != null && rsi14 < rsiPrev && rsiPrev > 60 && rsi14 <= 60) momentumScore -= 5;
  }
  momentumScore = clamp(momentumScore, 0, 100);

  // 3. 量價面 (0-100)：今日量價組合 + 5 日量能趨勢（對稱化）
  let volPriceScore = 50;
  if (volSignal === '量能爆發' && priceUp) volPriceScore += 22;       // 對稱化
  else if (volSignal === '量能爆發' && !priceUp) volPriceScore -= 22; // 出貨型態（由 -30 → -22）
  else if (volSignal === '量能放大' && priceUp) volPriceScore += 12;
  else if (volSignal === '量能放大' && !priceUp) volPriceScore -= 8;
  else if (volSignal === '量能萎縮' && priceUp) volPriceScore -= 6;
  else if (volSignal === '量能萎縮' && !priceUp) volPriceScore += 4;  // 量縮止跌
  if (priceVol === '價漲量增') volPriceScore += 10;
  else if (priceVol === '價漲量縮（背離）') volPriceScore -= 10;
  else if (priceVol === '價跌量增（出貨疑慮）') volPriceScore -= 15;
  // 5 日量能趨勢（近 5 日 / 前 5 日）
  if (vols.length >= 10) {
    const recent5 = avg(vols.slice(-5));
    const prior5 = avg(vols.slice(-10, -5)) || 1;
    const volTrend = recent5 / prior5;
    if (volTrend > 1.5 && priceUp) volPriceScore += 5;
    else if (volTrend < 0.7 && !priceUp) volPriceScore += 3;  // 量縮止跌
  }
  volPriceScore = clamp(volPriceScore, 0, 100);

  // 4. 籌碼面 (0-100)：法人方向（外資/投信權重高於自營）+ 投信佔比
  let chipScore = 50;
  // 外資 60% 權重、投信 30%、自營 10%
  const weightedInst = foreign * 0.6 + trust * 0.3 + dealer * 0.1;
  if (foreign > 0 && trust > 0 && dealer > 0) chipScore += 22;  // 三方共識
  else if (foreign > 0 && trust > 0) chipScore += 18;
  else if (foreign < 0 && trust < 0) chipScore -= 25;
  else if (weightedInst > 1000) chipScore += 8;
  else if (weightedInst < -1000) chipScore -= 12;
  // 投信佔股本比（中小型股作帳訊號）
  if (trustPctOfCap != null) {
    if (trustPctOfCap > 0.5) chipScore += 12;
    else if (trustPctOfCap > 0.2) chipScore += 6;
    else if (trustPctOfCap < -0.3) chipScore -= 10;
  }
  // ── 新聞情緒（輔助訊號，最多 ±8 分，避免噪音主導）──
  const ns = opts.newsSentiment;
  if (ns && ns.score != null && ns.total >= 3) {
    if (ns.score >= 0.5) chipScore += 8;
    else if (ns.score >= 0.2) chipScore += 4;
    else if (ns.score <= -0.5) chipScore -= 8;
    else if (ns.score <= -0.2) chipScore -= 4;
  }
  chipScore = clamp(chipScore, 0, 100);

  // ─── 權重汰換：依各模組過去 60 日命中率動態調整四面權重 ───
  const taiexHist = marketContext?.taiex_closes || null;
  const moduleAccuracy = perModuleWalkForward(k, { lookback: 60, holdDays: 5, taiexCloses: taiexHist });
  const dynW = computeDynamicWeights(moduleAccuracy);
  const W = dynW.weights;

  // 加權平均（四面 — 動態權重）
  const baseScore = trendScore * W.trend + momentumScore * W.momentum
                  + volPriceScore * W.volPrice + chipScore * W.chip;

  // ─── Feature Engineering：抽出 ML-ready feature vector + 給 baseScore 加分 ───
  const features = extractFeatures({
    closes, vols, k, ma5, ma20, ma60, last, prev, atr14, bias20, rsi14,
    kdK: cur.k, kdD: cur.d,
    foreign, trust, dealer,
    distToHigh, distToLow,
    marketContext, industryStats, fundamentals,
  });
  const featureContrib = applyFeatureContributions(features);
  const baseScoreEnhanced = clamp(baseScore + featureContrib.adjustment, 0, 100);

  // 5. 風險懲罰（罰分上限 30，避免單一情境多重扣分）
  let penalty = 0;
  if (bias20 != null && bias20 > 10 && cur.k > 80) penalty += 18;     // 高檔頂背離（由 25 → 18）
  if (volZ != null && volZ > 2 && !priceUp && bias20 > 5) penalty += 15;  // 量爆收黑（由 20 → 15）
  if (distToHigh < 2 && volSignal === '量能萎縮') penalty += 8;
  if (turnoverRate != null && turnoverRate > 15 && !priceUp) penalty += 8;
  penalty = Math.min(penalty, 30);                                     // 罰分天花板

  // ─── 預先計算 close/ATR/levels（避免後面 TDZ 引用） ───
  // ATR ratio 設計：target +2 ATR / stop -1.5 ATR → R/R = 1.33（前次 0.75，結構性負 EV）
  // 這個比例下，winRate >= 50% 即可達正 EV
  const close = last.close;
  const atr = atr14 || close * 0.025;
  const fmt2 = (n) => n != null ? +n.toFixed(2) : null;
  const entryLow  = fmt2(close - atr * 0.5);
  const entryHigh = fmt2(close + atr * 0.3);
  const support10 = ma5 != null ? fmt2(ma5) : fmt2(close - atr);
  const support20 = ma20 != null ? fmt2(ma20) : fmt2(close - atr * 2);
  // 停損候選：close - 1.5 ATR、5MA、20MA — 取 < close 中最高（最緊）
  const stopCandidates = [close - atr * 1.5, support10, support20].filter((v) => v != null && v < close);
  const stopPrice = fmt2(stopCandidates.length ? Math.max(...stopCandidates) : close - atr * 1.5);
  const target1 = fmt2(close + atr * 2);     // 1.5 → 2
  const target2 = fmt2(close + atr * 3.5);   // 3 → 3.5

  // ──────────────────────────────────────────────
  // 6. 集成投票（Ensemble）+ 信心收縮（Regularization）
  // 設計理念：四個維度獨立投出 -1 ~ +1 分，計算平均與一致性
  //   - 高一致性（mad 小）→ 信心高，winRate 偏離 50 較多
  //   - 低一致性（模組互打架）→ 信心低，winRate 收縮回 50 附近
  //   - 等同 L1/L2 正則化：防止單面分數主導
  // ──────────────────────────────────────────────
  const toVote = (s) => clamp((s - 50) / 30, -1, 1);  // 50 中性 → 0；80→+1；20→-1
  const votes = [toVote(trendScore), toVote(momentumScore), toVote(volPriceScore), toVote(chipScore)];
  const meanVote = avg(votes);
  const mad = avg(votes.map((v) => Math.abs(v - meanVote)));   // 平均絕對偏差
  const consistency = clamp(1 - mad, 0, 1);                    // 0=分歧 1=共識
  // shrinkFactor：一致性高才允許大幅偏離 50（保留至少 40% 收縮）
  const shrinkFactor = 0.4 + 0.6 * consistency;

  // ★ Volatility-aware shrinkage：高波動環境降低信心
  let volShrink = 1.0;
  if (features?.realized_vol_20d != null) {
    if (features.realized_vol_20d > 45)      volShrink = 0.80;
    else if (features.realized_vol_20d > 35) volShrink = 0.88;
    else if (features.realized_vol_20d > 28) volShrink = 0.94;
  }

  // 7. 經濟限制（Economic Constraints）
  // 流動性：近 20 日均「成交額（萬元）」< 5000 萬視為低流動性，訊號不可靠
  const avgTurnover20 = vols.length >= 20
    ? avg(vols.slice(-20).map((v, i) => (v || 0) * (closes[closes.length - 20 + i] || close) * 1000)) // 元
    : null;
  const liquidLevel = avgTurnover20 == null ? 'unknown'
    : avgTurnover20 >= 5e8 ? 'high'   // 5 億以上
    : avgTurnover20 >= 5e7 ? 'mid'    // 5000 萬以上
    : 'low';
  const liquidityShrink = liquidLevel === 'low' ? 0.7 : liquidLevel === 'mid' ? 0.9 : 1.0;

  // 交易成本可行性：台股單趟交易成本 ≈ 0.585%，雙趟 1.17%；目標報酬至少需覆蓋 2 倍交易成本
  const TX_COST_PCT = 1.17;
  const expectedRetTarget1 = ((target1 != null ? target1 : close) - close) / close * 100;
  const costFeasible = expectedRetTarget1 >= TX_COST_PCT * 2;  // ≥ 2.34%

  const economicShrink = liquidityShrink * (costFeasible ? 1.0 : 0.85) * volShrink;

  // ─── 雙路線最終勝率（提供 ROI 對照）───
  // 1) Legacy（feature 升級前）：使用 baseScore（無 feature 加分）
  let regularizedBaseLegacy = 50 + (baseScore - 50) * shrinkFactor;
  const dailyLeaningL = regularizedBaseLegacy > 55 ? 'long' : regularizedBaseLegacy < 45 ? 'short' : 'neutral';
  const mtfConsonantL = (dailyLeaningL === 'long' && weeklyTrend === 'up') || (dailyLeaningL === 'short' && weeklyTrend === 'down');
  const mtfDivergentL = (dailyLeaningL === 'long' && weeklyTrend === 'down') || (dailyLeaningL === 'short' && weeklyTrend === 'up');
  let mtfMulL = 1.0;
  if (mtfConsonantL) mtfMulL = 1.10;
  else if (mtfDivergentL) mtfMulL = 0.75;
  regularizedBaseLegacy = 50 + (regularizedBaseLegacy - 50) * mtfMulL;
  // legacy 不套 volShrink（feature 升級之前根本沒有 realized_vol）
  const economicShrinkLegacy = liquidityShrink * (costFeasible ? 1.0 : 0.85);
  const finalScoreLegacy = 50 + (regularizedBaseLegacy - 50) * economicShrinkLegacy - penalty;
  const legacyWinRate = Math.round(clamp(finalScoreLegacy, 15, 78));

  // 2) Enhanced（feature 升級後）：使用 baseScoreEnhanced
  let regularizedBase = 50 + (baseScoreEnhanced - 50) * shrinkFactor;
  const dailyLeaning = regularizedBase > 55 ? 'long' : regularizedBase < 45 ? 'short' : 'neutral';
  const mtfConsonant = (dailyLeaning === 'long' && weeklyTrend === 'up') || (dailyLeaning === 'short' && weeklyTrend === 'down');
  const mtfDivergent = (dailyLeaning === 'long' && weeklyTrend === 'down') || (dailyLeaning === 'short' && weeklyTrend === 'up');
  let mtfMultiplier = 1.0;
  if (mtfConsonant) mtfMultiplier = 1.10;
  else if (mtfDivergent) mtfMultiplier = 0.75;
  regularizedBase = 50 + (regularizedBase - 50) * mtfMultiplier;
  const finalScore = 50 + (regularizedBase - 50) * economicShrink - penalty;
  const winRate = Math.round(clamp(finalScore, 15, 78));

  // ─── 期望值 (Expected Value) — 加入賠率思維 ───
  // EV = 勝率 × 上漲空間 − (1−勝率) × 下跌空間
  // 同樣勝率，盈虧比差的 EV 可能為負（不該進場）；勝率不高但盈虧比好的 EV 可能正（該進）
  const upsidePct = target1 != null ? +(((target1 - close) / close) * 100).toFixed(2) : null;
  const downsidePct = stopPrice != null ? +(((close - stopPrice) / close) * 100).toFixed(2) : null;
  const upsideTarget2Pct = target2 != null ? +(((target2 - close) / close) * 100).toFixed(2) : null;
  const rrRatio = (upsidePct != null && downsidePct != null && downsidePct > 0)
    ? +(upsidePct / downsidePct).toFixed(2) : null;
  const winProb = winRate / 100;
  const evTarget1 = (upsidePct != null && downsidePct != null)
    ? +(winProb * upsidePct - (1 - winProb) * downsidePct).toFixed(2) : null;
  const evTarget2 = (upsideTarget2Pct != null && downsidePct != null)
    ? +(winProb * upsideTarget2Pct - (1 - winProb) * downsidePct).toFixed(2) : null;
  const evCategory = evTarget1 == null ? 'unknown'
    : evTarget1 >= 2 ? 'excellent'
    : evTarget1 >= 0.5 ? 'positive'
    : evTarget1 >= -0.5 ? 'neutral'
    : 'negative';

  // 8. Walk-forward 歷史驗證 — 跑兩次（feature-augmented + legacy）取得 ROI 對照
  const historicalAccuracy = walkForwardAccuracy(k, { lookback: 60, holdDays: 5, taiexCloses: taiexHist });
  const historicalAccuracyLegacy = walkForwardAccuracy(k, { lookback: 60, holdDays: 5, taiexCloses: null });

  // ─────── 進場 / 停損 / 目標價已於前面計算（close/atr/support10/support20/stopPrice/target1/target2） ───────

  // ─────── overall / action / playbook 判讀 ───────
  // ★ 強勢突破 override：當日漲停 / 大紅棒帶量 → 強迫升級為「多方明確」即使 winRate 沒到 60
  const hasStrongBreakout = featureContrib.contributions.limit_up_breakout
    || featureContrib.contributions.strong_breakout;
  const effectiveWinRate = hasStrongBreakout ? Math.max(winRate, 62) : winRate;

  let overall, action, playbook;
  if (effectiveWinRate >= 60) {  // 由 65 → 60
    overall = '多頭格局・趨勢向上';
    action = [
      `▶ 進場區：${entryLow} ~ ${entryHigh}（現價附近回測 0.5 ATR）`,
      `▶ 加碼區：跌至 20MA ${support20} 加碼 30%（突破前高 +20%）`,
      `▶ 停損：跌破 ${stopPrice}（-2 ATR）或失守 10MA ${support10}`,
      `▶ 目標：第一停利 ${target1}（+1.5 ATR），第二停利 ${target2}（+3 ATR）`,
    ];
    playbook = `多方明確：可分 3 批進場（首批 50% 立即/${entryLow}~${entryHigh}、回測 20MA ${support20} 加碼 30%、突破前高 ${high60.toFixed(2)} 再加 20%）。停損 ${stopPrice}，達 ${target1} 後停利點上移到成本價，超過 ${target2} 改用 20MA 動態出場。`;
  } else if (effectiveWinRate >= 50) {   // 由 55 → 50
    overall = '中期偏多・短線觀察';
    action = [
      `▶ 進場區：等待回測 5MA ${support10} 或 20MA ${support20} 再進場`,
      `▶ 不追價：${close.toFixed(2)} 以上不主動追高`,
      `▶ 停損：跌破 ${stopPrice}（-2 ATR）出場`,
      `▶ 目標：${target1}（+1.5 ATR）為短線停利點`,
    ];
    playbook = `偏多但需等支撐：${close.toFixed(2)} 不追價，回測 ${support10}（5MA）輕倉 30%、回測 ${support20}（20MA）再加碼 30%。突破 ${high60.toFixed(2)} 才確認轉強。停損 ${stopPrice}，達 ${target1} 先停利一半。`;
  } else if (effectiveWinRate >= 42) {   // 由 45 → 42
    overall = '盤整待變・方向未明';
    action = [
      `▶ 觀望優先：${close.toFixed(2)} 在多空交界，避免重押`,
      `▶ 短線區間：上 ${entryHigh}、下 ${support10}（區間操作）`,
      `▶ 試水部位：上限總部位 10%，停損 ${stopPrice}`,
      `▶ 等待訊號：突破 ${high60.toFixed(2)} 轉多 / 跌破 ${low60.toFixed(2)} 轉空`,
    ];
    playbook = `盤整格局：建議空手或極輕倉（≤10%）。等突破 ${high60.toFixed(2)} 確認多方，或跌破 ${low60.toFixed(2)} 確認空方再做方向。當沖可作 ${support10}~${entryHigh} 區間，但留意流動性。`;
  } else if (effectiveWinRate >= 30) {
    overall = '中期偏空・反彈逢高減碼';
    action = [
      `▶ 持股減碼：反彈到 ${ma5 != null ? fmt2(ma5) : entryHigh} 即減 50%`,
      `▶ 不接刀：${close.toFixed(2)} 不嘗試逢低承接`,
      `▶ 停損嚴守：跌破 ${stopPrice} 全數出場`,
      `▶ 等待訊號：站回 20MA ${support20} 才考慮重新評估`,
    ];
    playbook = `偏空格局：手中部位逢反彈（${ma5 != null ? fmt2(ma5) : entryHigh}）即減碼 50%，跌破 ${stopPrice} 全部清空。新進場一律觀望，需見「站回 20MA + 法人翻買 + 量縮止跌」三條件齊備才考慮回補。`;
  } else {
    overall = '空頭格局・趨勢向下';
    action = [
      `▶ 空手為上：${close.toFixed(2)} 不持股、不抄底`,
      `▶ 既有部位停損：跌破 ${stopPrice} 立即出場`,
      `▶ 觀察點：${low60.toFixed(2)}（60 日低）+ KD 低檔背離`,
      `▶ 翻多訊號：站回 20MA ${support20} + 量增`,
    ];
    playbook = `空頭明確：堅持空手。重新進場需符合三條件：(1) 站回 20MA ${support20}；(2) 法人連 3 日買超；(3) KD 自低檔上彎。任一不滿足即繼續觀望，禁追跌不停損。`;
  }

  // 子項細分（給 UI 顯示拆解）
  const subScores = {
    trend: Math.round(trendScore),
    momentum: Math.round(momentumScore),
    volPrice: Math.round(volPriceScore),
    chip: Math.round(chipScore),
    penalty: Math.round(penalty),
  };

  return {
    trend, trendNote, shortTrend,
    ma: { ma5, ma20, ma60 },
    kd: { ...cur, signal: kdSignal, level: kdLevel },
    macd: { dif: difLast, dem: demLast, osc: oscLast, signal: macdSignal },
    vol: { ratio: volRatio, signal: volSignal, priceVol },
    inst: {
      foreign, trust, dealer, total: totalInst, mainForce,
      trustPctOfCap,
      bias: { foreign: biasLabel(foreign), trust: biasLabel(trust), dealer: biasLabel(dealer) },
    },
    range: { high60, low60, distToHigh, distToLow },
    bias20, atr14, maDeduct20, volZ, turnoverRate,
    signals,
    score, winRate,
    expectedValue: {                                     // ★ EV 期望值（盈虧比加權勝率）
      target1: evTarget1,                                // EV @ 第一停利
      target2: evTarget2,                                // EV @ 第二停利
      upside: upsidePct,                                 // 上漲空間 %
      downside: downsidePct,                             // 下跌空間 %
      rrRatio,                                           // 盈虧比 = 上 / 下
      category: evCategory,                              // excellent / positive / neutral / negative
    },
    legacyWinRate,                                       // ★ ROI 對照：feature 升級前的勝率
    featureUpgrade: {                                    // ★ Feature engineering 貢獻明細
      delta: winRate - legacyWinRate,
      adjustment: featureContrib.adjustment,             // baseScore 加分 (+/-)
      contributions: featureContrib.contributions,       // 各 feature 貢獻拆解
      volShrink: +volShrink.toFixed(2),                  // 高波動降信心
    },
    features,                                            // ★ ML-ready 特徵向量（25+ 項）
    subScores,
    overall, action, playbook,
    direction: winRate >= 55 ? 'long' : winRate >= 45 ? 'neutral' : 'short',
    rsi14, rsiPrev,
    // 過擬合對策衍生指標
    consistency: +(consistency * 100).toFixed(0),       // 0-100：四面共識度
    moduleVotes: { trend: +votes[0].toFixed(2), momentum: +votes[1].toFixed(2), volPrice: +votes[2].toFixed(2), chip: +votes[3].toFixed(2) },
    historicalAccuracy,                                  // walk-forward（已含 feature 升級）
    historicalAccuracyLegacy,                            // walk-forward（feature 升級前對照）
    moduleAccuracy,                                      // walk-forward 各模組命中率
    dynamicWeights: { weights: W, adjusted: dynW.adjusted, factors: dynW.factors },
    // 短期路線圖實作
    multiTimeframe: {
      weeklyTrend,
      weeklyClose: weeklyClose != null ? +weeklyClose.toFixed(2) : null,
      weeklyMa4: weeklyMa4 != null ? +weeklyMa4.toFixed(2) : null,
      consonant: mtfConsonant,
      divergent: mtfDivergent,
      multiplier: mtfMultiplier,
    },
    relativeStrength: rs,                                // vs TAIEX 60 日超額報酬
    newsSentiment: opts.newsSentiment || null,           // 新聞情緒（由 server 算好傳入）
    backtest,                                            // 60 日輕量回測：勝率/累積報酬/Sharpe/MaxDD
    economic: {
      liquidity: liquidLevel,
      avgTurnover20,                                     // 元
      costFeasible,
      txCostPct: TX_COST_PCT,
      expectedReturn: +expectedRetTarget1.toFixed(2),
    },
    levels: {
      entryLow, entryHigh,
      stop: stopPrice,
      target1, target2,
      support10, support20,
      high60: +high60.toFixed(2),
      low60: +low60.toFixed(2),
    },
  };
}
