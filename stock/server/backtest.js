// Backtest 框架 — Ablation study
// 模擬「按系統訊號每筆持有 5 個交易日」的真實 PnL，扣 1.17% 雙趟交易成本
// 5 路線對照：
//   baseline    — 永遠買多，相當於 buy-and-hold 等權重
//   legacy      — 升級前（無 RS、無產業、無 regime）
//   current     — 升級後（RS + 產業 + regime 全開）
//   no-industry — 升級後但關掉產業 RS
//   no-regime   — 升級後但關掉大盤 regime
// 用 cache 24h（耗時但結果一天內穩定）

import { memo } from './cache.js';
import * as finmind from './providers/finmind.js';
import * as yahoo from './providers/yahoo.js';
import { calcRSI } from '../src/utils/diagnose.js';
import { getAllIndustryStats } from './industryContext.js';

const HOLD_DAYS = 5;
const TX_COST = 0.0117;       // 雙趟 1.17%
const PEERS = [
  '2330','2317','2454','2308','2891','2882','2412','3008','2303','2881',
  '2884','2886','2885','2880','2890','1301','1303','2002','1216','2207',
  '3711','2382','2912','3034','2615','2603','2618','5871','3045','4904',
  '2887','2105','9904','1102','2606','3037','3231','5347','6505','2474',
  '2376','3702','2357','2059','3017','2049','3553','2360','2392','3056',
  '2455','3035','2421','2027','1326','2379','2609','2610',
];

const avg = (arr) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1);
const std = (arr) => {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
};

// ─── 評分函式 v2：Long-only + 反轉進場 + 強度門檻 ───
// 三大優化：
//   1. Long-only — 牛市做空必死，全面拿掉 short
//   2. 反轉進場 — 跳過 RSI > 75（追高過熱）與 < 40（接刀），偏好拉回（40-55）或溫和突破（60-70）
//   3. 強度門檻 — score >= 3 才進場（legacy 因無 RS/industry 加分機會放寬到 2）
function scoreAt(slice, taiexSlice, industryRank, taiexTrendAtT, variant) {
  if (variant === 'baseline') return 'long';
  const last = slice[slice.length - 1];
  const closes = slice.map((d) => d.close);
  if (closes.length < 25) return 'neutral';

  const ma5 = avg(closes.slice(-5));
  const ma20 = avg(closes.slice(-20));
  const rsi = calcRSI(closes, 14);
  if (rsi == null) return 'neutral';

  // ─ 必要條件 ─
  if (ma5 <= ma20 || last.close <= ma20) return 'neutral';  // 必須在上升趨勢中
  if (rsi > 75 || rsi < 40) return 'neutral';               // 過熱/太弱直接跳過

  // 大盤 regime guard（legacy / no-regime 不用）
  if (variant !== 'legacy' && variant !== 'no-regime' && taiexTrendAtT === -1) return 'neutral';

  // ─ 評分 ─
  let score = 0;

  // 1. 進場型態（拉回 40-55 或溫和突破 60-70 較佳；55-60 中性）
  if ((rsi >= 40 && rsi <= 55) || (rsi >= 60 && rsi <= 70)) score += 2;
  else score += 1;

  // 2. RS vs TAIEX（legacy 不用）
  if (variant !== 'legacy' && taiexSlice && taiexSlice.length >= 61 && closes.length >= 61) {
    const sRet = (last.close - closes[closes.length - 61]) / closes[closes.length - 61];
    const tRet = (taiexSlice[taiexSlice.length - 1] - taiexSlice[taiexSlice.length - 61]) / taiexSlice[taiexSlice.length - 61];
    const rs = (sRet - tRet) * 100;
    if (rs > 7) score += 2;
    else if (rs > 3) score += 1;
    else if (rs < -3) score -= 1;
  }

  // 3. 產業 RS（legacy / no-industry 不用）
  if (variant !== 'legacy' && variant !== 'no-industry' && industryRank != null) {
    if (industryRank > 0.7) score += 2;
    else if (industryRank > 0.5) score += 1;
    else if (industryRank < 0.3) return 'neutral';  // 產業後段直接淘汰
  }

  // 門檻：legacy 因無 RS/industry 加分機會 → 放寬到 2
  const threshold = variant === 'legacy' ? 2 : 3;
  return score >= threshold ? 'long' : 'neutral';
}

function taiexTrendAt(taiexCloses, idx) {
  if (idx < 60) return 0;
  const slice = taiexCloses.slice(0, idx + 1);
  const last = slice[slice.length - 1];
  const ma20 = avg(slice.slice(-20));
  const ma60 = avg(slice.slice(-60));
  if (ma20 > ma60 && last > ma20) return 1;
  if (ma20 < ma60 && last < ma20) return -1;
  return 0;
}

// 給定該股當下日期、所有同產業股票的 K 線，算 industry RS rank（0-1）
function industryRsAt(code, dateStr, kAtIdx, klines, industryMap) {
  const ind = industryMap[code];
  if (!ind) return null;
  // 個股 60 日報酬
  const myK = klines[code];
  const myIdx = myK.findIndex((d) => d.date === dateStr);
  if (myIdx < 60) return null;
  const myRet = (myK[myIdx].close - myK[myIdx - 60].close) / myK[myIdx - 60].close;

  const peerRets = [];
  for (const c of Object.keys(klines)) {
    if (c === code || industryMap[c] !== ind) continue;
    const k = klines[c];
    const idx = k.findIndex((d) => d.date === dateStr);
    if (idx < 60) continue;
    if (k[idx - 60].close > 0) {
      peerRets.push((k[idx].close - k[idx - 60].close) / k[idx - 60].close);
    }
  }
  if (peerRets.length < 3) return null;
  const lower = peerRets.filter((r) => r < myRet).length;
  return lower / (peerRets.length - 1 || 1);
}

// ─── 主流程 ───
export async function runBacktest({ codes = PEERS, lookbackDays = 252 } = {}) {
  const start = new Date(Date.now() - (lookbackDays + 90) * 86400e3).toISOString().slice(0, 10);

  // 1. 拉所有股票 K 線（並行 + 各自 cache，FinMind → Yahoo fallback）
  const klines = {};
  await Promise.all([...new Set(codes)].map(async (code) => {
    let raw = null;
    // 主源 FinMind
    try {
      raw = await memo(`bt:kline:${code}`, 60 * 60 * 1000, () => finmind.stockPrice(code, start));
      if (!raw || raw.length < 90) raw = null;
    } catch { raw = null; }
    // 備援 Yahoo
    if (!raw) {
      try {
        const yh = await memo(`bt:yh:${code}`, 60 * 60 * 1000, () => yahoo.chart(`${code}.TW`, '1y', '1d'));
        if (yh && yh.length >= 90) {
          raw = yh.map((d) => ({
            date: d.date,
            open: d.open, close: d.close,
            max: d.high, min: d.low,
            Trading_Volume: Math.round((d.volume || 0) / 1000),
          }));
        }
      } catch { /* skip */ }
    }
    if (!raw) return;
    klines[code] = raw.map((r) => ({
      date: r.date,
      open: +r.open, close: +r.close,
      high: +(r.max ?? r.high), low: +(r.min ?? r.low),
      vol: +(r.Trading_Volume ?? r.volume ?? 0),
    })).filter((d) => Number.isFinite(d.close));
  }));

  // 2. TAIEX 歷史
  let taiexCloses = [];
  try {
    const t = await memo('bt:taiex', 24 * 60 * 60 * 1000, () => yahoo.chart('^TWII', '1y', '1d'));
    taiexCloses = (t || []).map((d) => +d.close).filter(Number.isFinite);
  } catch { /* skip */ }

  // 3. 產業對照表
  let industryMap = {};
  try {
    const ind = await getAllIndustryStats();
    industryMap = ind?.codeToIndustry || {};
  } catch { /* skip */ }

  // 4. 模擬 5 個 variants
  const variants = ['baseline', 'legacy', 'current', 'no-industry', 'no-regime'];
  const results = {};

  // ── Baseline: 真正的 Buy-and-Hold（單筆持有到底，扣 1 次 TX）──
  results.baseline = simulateBuyAndHold(klines);

  // ── 其他 4 個：訊號型策略 ──
  for (const variant of variants) {
    if (variant === 'baseline') continue;
    const trades = [];
    for (const code of Object.keys(klines)) {
      const k = klines[code];
      const taiexAligned = taiexCloses.length >= k.length
        ? taiexCloses.slice(taiexCloses.length - k.length)
        : null;
      for (let i = 60; i < k.length - HOLD_DAYS; i++) {
        const slice = k.slice(0, i + 1);
        const taiexSlice = taiexAligned ? taiexAligned.slice(0, i + 1) : null;
        let indRank = null;
        if (variant === 'current') {
          indRank = industryRsAt(code, k[i].date, i, klines, industryMap);
        }
        const taiexTr = taiexSlice ? taiexTrendAt(taiexSlice, taiexSlice.length - 1) : 0;
        const dir = scoreAt(slice, taiexSlice, indRank, taiexTr, variant);
        if (!dir || dir === 'neutral') continue;
        const entry = k[i].close;
        const exit = k[i + HOLD_DAYS].close;
        if (!(entry > 0)) continue;
        const grossRet = (exit - entry) / entry;
        const sign = dir === 'long' ? 1 : -1;
        const netRet = sign * grossRet - TX_COST;
        trades.push({ code, date: k[i].date, dir, ret: netRet });
      }
    }
    results[variant] = aggregate(trades);
  }

  return {
    runAt: new Date().toISOString(),
    universe: Object.keys(klines).length,
    lookbackDays,
    holdDays: HOLD_DAYS,
    txCost: TX_COST,
    results,
  };
}

// 真正的 Buy-and-Hold 模擬：每檔股票第 60 天進場 → 持有到最後一天 → 收一次 1.17% 雙趟成本
// daily portfolio return = 各股當日 mark-to-market 報酬的等權平均
function simulateBuyAndHold(klines) {
  const codes = Object.keys(klines).filter((c) => klines[c].length >= 90);
  if (!codes.length) {
    return { trades: 0, tradingDays: 0, winRate: null, cumulativeReturn: 0, avgReturn: null, sharpe: 0, maxDrawdown: 0, equity: [] };
  }
  const byDate = new Map();
  for (const code of codes) {
    const k = klines[code];
    const startIdx = 60;
    for (let i = startIdx + 1; i < k.length; i++) {
      if (k[i - 1].close > 0) {
        const r = (k[i].close - k[i - 1].close) / k[i - 1].close;
        if (!byDate.has(k[i].date)) byDate.set(k[i].date, []);
        byDate.get(k[i].date).push(r);
      }
    }
  }
  const dailyReturns = [];
  let eq = 1, peak = 1, maxDD = 0;
  const equity = [];
  for (const [date, rets] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dayRet = avg(rets);
    dailyReturns.push(dayRet);
    eq *= (1 + dayRet);
    equity.push({ date, eq: +eq.toFixed(4) });
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  // 收尾扣 1 次雙趟成本
  eq *= (1 - TX_COST);
  if (equity.length) equity[equity.length - 1].eq = +eq.toFixed(4);
  const m = avg(dailyReturns);
  const s = std(dailyReturns);
  const sharpe = s > 0 ? +((m / s) * Math.sqrt(252)).toFixed(2) : 0;
  const step = Math.max(1, Math.floor(equity.length / 60));
  const thinned = equity.filter((_, i) => i === 0 || i === equity.length - 1 || i % step === 0);
  return {
    trades: codes.length,
    tradingDays: dailyReturns.length,
    winRate: null,
    cumulativeReturn: +((eq - 1) * 100).toFixed(2),
    avgReturn: null,
    sharpe,
    maxDrawdown: +(maxDD * 100).toFixed(1),
    equity: thinned,
  };
}

function aggregate(trades) {
  if (!trades.length) {
    return { trades: 0, winRate: 0, cumulativeReturn: 0, avgReturn: 0, sharpe: 0, maxDrawdown: 0, equity: [] };
  }
  // 修正：按進場日期分組，每日取「跨股等權平均報酬」當作當日組合報酬
  // （等同「把當天所有訊號平分資金」），再以日報酬複利成 equity curve
  trades.sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map();
  for (const t of trades) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t.ret);
  }
  const dailyReturns = [];
  let eq = 1, peak = 1, maxDD = 0;
  const equity = [];
  for (const [date, rets] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dayRet = avg(rets);
    dailyReturns.push(dayRet);
    eq *= (1 + dayRet);
    equity.push({ date, eq: +eq.toFixed(4) });
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  const wins = trades.filter((t) => t.ret > 0).length;
  const winRate = +((wins / trades.length) * 100).toFixed(1);
  const m = avg(dailyReturns);
  const s = std(dailyReturns);
  // Sharpe：用「日組合報酬」年化（252 交易日）
  const sharpe = s > 0 ? +((m / s) * Math.sqrt(252)).toFixed(2) : 0;
  const avgPerTrade = avg(trades.map((t) => t.ret));

  // Equity 取樣：保留首尾 + 等距 60 點
  const step = Math.max(1, Math.floor(equity.length / 60));
  const thinned = equity.filter((_, i) => i === 0 || i === equity.length - 1 || i % step === 0);

  return {
    trades: trades.length,
    tradingDays: dailyReturns.length,
    winRate,
    cumulativeReturn: +((eq - 1) * 100).toFixed(2),
    avgReturn: +(avgPerTrade * 100).toFixed(3),
    sharpe,
    maxDrawdown: +(maxDD * 100).toFixed(1),
    equity: thinned,
  };
}
