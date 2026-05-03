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

// ─── 評分函式（5 個 variants 共用，差別在 flag）───
function scoreAt(slice, taiexSlice, industryRank, taiexTrendAtT, variant) {
  if (variant === 'baseline') return 'long';
  const last = slice[slice.length - 1];
  const closes = slice.map((d) => d.close);
  if (closes.length < 25) return 'neutral';

  const ma5 = avg(closes.slice(-5));
  const ma20 = avg(closes.slice(-20));
  const rsi = calcRSI(closes, 14);
  let trendV = ma5 > ma20 ? 1 : -1;
  const priceV = last.close > ma20 ? 1 : -1;
  const momV = rsi == null ? 0 : (rsi > 55 ? 1 : rsi < 45 ? -1 : 0);

  // RS vs TAIEX（legacy 不用）
  if (variant !== 'legacy' && taiexSlice && taiexSlice.length >= 61 && closes.length >= 61) {
    const sRet = (last.close - closes[closes.length - 61]) / closes[closes.length - 61];
    const tRet = (taiexSlice[taiexSlice.length - 1] - taiexSlice[taiexSlice.length - 61]) / taiexSlice[taiexSlice.length - 61];
    const rs = (sRet - tRet) * 100;
    if (rs > 7) trendV = 1;
    else if (rs < -7) trendV = -1;
  }

  // Industry RS（legacy / no-industry 不用）
  let industryV = 0;
  if (variant !== 'legacy' && variant !== 'no-industry' && industryRank != null) {
    if (industryRank > 0.7) industryV = 1;
    else if (industryRank < 0.3) industryV = -1;
  }

  // Regime（legacy / no-regime 不用）
  let regimeV = 0;
  if (variant !== 'legacy' && variant !== 'no-regime' && taiexTrendAtT === -1) {
    regimeV = -1; // 大盤空頭整體偏空
  }

  const sum = trendV + priceV + momV + industryV + regimeV;
  return sum >= 2 ? 'long' : sum <= -2 ? 'short' : 'neutral';
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

  // 1. 拉所有股票 K 線（並行 + 各自 cache）
  const klines = {};
  await Promise.all([...new Set(codes)].map(async (code) => {
    try {
      const k = await memo(`bt:kline:${code}`, 60 * 60 * 1000, () => finmind.stockPrice(code, start));
      if (!k || k.length < 90) return;
      klines[code] = k.map((r) => ({
        date: r.date,
        open: +r.open, close: +r.close,
        high: +(r.max ?? r.high), low: +(r.min ?? r.low),
        vol: +(r.Trading_Volume ?? r.volume ?? 0),
      })).filter((d) => Number.isFinite(d.close));
    } catch { /* skip */ }
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

  for (const variant of variants) {
    const trades = [];
    for (const code of Object.keys(klines)) {
      const k = klines[code];
      // TAIEX 對齊（截到 k.length）
      const taiexAligned = taiexCloses.length >= k.length
        ? taiexCloses.slice(taiexCloses.length - k.length)
        : null;
      // 從 60 起算（讓 MA60 / 60 日報酬有資料）；最後 5 天因 hold 期外不計
      for (let i = 60; i < k.length - HOLD_DAYS; i++) {
        const slice = k.slice(0, i + 1);
        const taiexSlice = taiexAligned ? taiexAligned.slice(0, i + 1) : null;
        // industry RS only if needed by variant
        let indRank = null;
        if (variant === 'current') {
          indRank = industryRsAt(code, k[i].date, i, klines, industryMap);
        }
        const taiexTr = taiexSlice ? taiexTrendAt(taiexSlice, taiexSlice.length - 1) : 0;
        const dir = scoreAt(slice, taiexSlice, indRank, taiexTr, variant);
        if (!dir || dir === 'neutral') continue;
        // 模擬交易
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

function aggregate(trades) {
  if (!trades.length) {
    return { trades: 0, winRate: 0, cumulativeReturn: 0, avgReturn: 0, sharpe: 0, maxDrawdown: 0, equity: [] };
  }
  trades.sort((a, b) => a.date.localeCompare(b.date));
  // 等權配置 — 每筆獨立帳戶複利，最後再平均
  // 簡化：把所有 trades 串成一條 equity（單一資金池每次全押）
  let eq = 1, peak = 1, maxDD = 0;
  const eqByDate = new Map();
  for (const t of trades) {
    eq *= (1 + t.ret);
    eqByDate.set(t.date, eq);
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  const wins = trades.filter((t) => t.ret > 0).length;
  const winRate = +((wins / trades.length) * 100).toFixed(1);
  const rets = trades.map((t) => t.ret);
  const m = avg(rets);
  const s = std(rets);
  // Sharpe annualized：5 日持有，一年約 50 筆，sqrt(50) 換算
  const sharpe = s > 0 ? +((m / s) * Math.sqrt(50)).toFixed(2) : 0;
  // Equity curve thinned to monthly points
  const equity = [...eqByDate.entries()].filter((_, i, a) => i === a.length - 1 || i % Math.max(1, Math.floor(a.length / 60)) === 0)
    .map(([date, eq]) => ({ date, eq: +eq.toFixed(4) }));

  return {
    trades: trades.length,
    winRate,
    cumulativeReturn: +((eq - 1) * 100).toFixed(2),
    avgReturn: +(m * 100).toFixed(3),
    sharpe,
    maxDrawdown: +(maxDD * 100).toFixed(1),
    equity,
  };
}
