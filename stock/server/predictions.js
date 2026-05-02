// 預測追蹤 / 自我學習回饋迴路
// 流程：record() → validate() → getStats() → getConfidenceMultiplier() → 套回 diagnose
//
// 設計重點：
//   1. In-memory Map 為一級存放，定期 persist() 到 server/data/predictions.json
//   2. 同一檔同一日只記一筆（避免反覆 query 灌爆）
//   3. 每筆預測等 HOLD_DAYS 個交易日後比對實際收盤算 hit/miss + 誤差
//   4. 連續 3 天 |預測-實際| > 5% → 標記為「大誤差」，自動降低該股訊號強度
//   5. Railway container fs ephemeral，重啟時 load() 不到資料就從零開始累積

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.resolve(__dirname, 'data');
const STORE_FILE = path.join(STORE_DIR, 'predictions.json');

// 結構：Map<code, [{date, close, winRate, direction, target1, expectedReturn, validated, ...}]>
const store = new Map();
const HOLD_DAYS = 5;          // 預測標記後 5 個交易日才能驗證
const MAX_PER_STOCK = 90;     // 每檔保留最近 90 筆
const RECENT_WINDOW = 20;     // 最近準確度看最近 20 筆

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ──────────────── record ────────────────
// 同一天同一檔只記一筆（後面的覆蓋前面的，winRate 以最後一次為準）
export function record(code, prediction) {
  if (!code || !prediction) return;
  if (prediction.close == null || !Number.isFinite(prediction.close)) return;
  const today = new Date().toISOString().slice(0, 10);
  const arr = store.get(code) || [];
  const idx = arr.findIndex((p) => p.date === today);
  const entry = {
    date: today,
    close: +prediction.close,
    winRate: prediction.winRate ?? null,
    direction: prediction.direction ?? null,
    target1: prediction.target1 ?? null,
    stop: prediction.stop ?? null,
    expectedReturn: prediction.expectedReturn ?? null,
    recordedAt: Date.now(),
    validated: false,
  };
  if (idx >= 0) {
    // 保留 validated 結果，只更新預測欄位
    if (arr[idx].validated) entry.validated = true;
    Object.assign(arr[idx], entry);
  } else {
    arr.push(entry);
  }
  // 截斷舊資料
  if (arr.length > MAX_PER_STOCK) arr.splice(0, arr.length - MAX_PER_STOCK);
  store.set(code, arr);
}

// ──────────────── validate ────────────────
// 對未驗證的預測，找 HOLD_DAYS 交易日後的實際收盤
// kline 必須是依日期升冪排列的 [{date, close}, ...]
export function validate(code, kline) {
  if (!Array.isArray(kline) || kline.length < HOLD_DAYS + 1) return 0;
  const arr = store.get(code);
  if (!arr || !arr.length) return 0;

  // 索引：date → close（FinMind/Yahoo 都是 ISO 日期）
  const closeByDate = new Map();
  const datesAsc = [];
  kline.forEach((d) => {
    if (d.date && Number.isFinite(d.close)) {
      closeByDate.set(d.date, d.close);
      datesAsc.push(d.date);
    }
  });

  let validatedCount = 0;
  for (const p of arr) {
    if (p.validated) continue;
    if (!p.date || !Number.isFinite(p.close)) continue;

    // 找 K 線中第一個「至少在 p.date 後 HOLD_DAYS 個交易日」的 bar
    const startIdx = datesAsc.findIndex((d) => d > p.date);
    if (startIdx < 0) continue;
    const targetIdx = startIdx + HOLD_DAYS - 1;     // -1 因為 startIdx 已是「至少 1 天後」
    if (targetIdx >= datesAsc.length) continue;     // 還沒到驗證日

    const actualDate = datesAsc[targetIdx];
    const actualClose = closeByDate.get(actualDate);
    if (!Number.isFinite(actualClose)) continue;

    const actualReturn = ((actualClose - p.close) / p.close) * 100;
    const expectedSign = p.direction === 'long' ? 1 : p.direction === 'short' ? -1 : 0;
    const actualSign   = actualReturn > 0 ? 1 : actualReturn < 0 ? -1 : 0;

    p.validated = true;
    p.actualClose = +actualClose.toFixed(2);
    p.actualDate = actualDate;
    p.actualReturn = +actualReturn.toFixed(2);
    p.directionHit = expectedSign !== 0 && expectedSign === actualSign;
    p.expectedError = p.expectedReturn != null
      ? +(actualReturn - p.expectedReturn).toFixed(2)
      : null;
    p.absError = p.expectedError != null ? Math.abs(p.expectedError) : null;
    validatedCount++;
  }
  if (validatedCount) store.set(code, arr);
  return validatedCount;
}

// ──────────────── getStats ────────────────
export function getStats(code) {
  const arr = store.get(code);
  if (!arr || !arr.length) {
    return { samples: 0, totalRecorded: 0, recentSampleCount: 0, recentHitRate: null, mae: null, consecutiveBigError: false, last: null };
  }
  const validated = arr.filter((p) => p.validated && p.directionHit != null);
  const totalRecorded = arr.length;
  if (!validated.length) {
    return { samples: 0, totalRecorded, pending: arr.filter((p) => !p.validated).length, recentSampleCount: 0, recentHitRate: null, mae: null, consecutiveBigError: false, last: null };
  }

  const recent = validated.slice(-RECENT_WINDOW);
  const hits = recent.filter((p) => p.directionHit).length;
  const recentHitRate = +((hits / recent.length) * 100).toFixed(1);
  const errors = recent.map((p) => p.absError).filter((e) => e != null);
  const mae = errors.length ? +(errors.reduce((s, e) => s + e, 0) / errors.length).toFixed(2) : null;

  // 連 3 筆絕對誤差 > 5%（注意是「最近 3 筆已驗證」，不是「3 個自然日」）
  const last3 = validated.slice(-3);
  const consecutiveBigError = last3.length === 3 && last3.every((p) => p.absError != null && p.absError > 5);

  const lastP = validated[validated.length - 1];
  const last = lastP ? {
    date: lastP.date,
    actualDate: lastP.actualDate,
    predictedReturn: lastP.expectedReturn,
    actualReturn: lastP.actualReturn,
    error: lastP.expectedError,
    direction: lastP.direction,
    hit: lastP.directionHit,
  } : null;

  return {
    samples: validated.length,
    totalRecorded,
    pending: arr.filter((p) => !p.validated).length,
    recentSampleCount: recent.length,
    recentHitRate,
    mae,
    consecutiveBigError,
    last,
  };
}

// ──────────────── 信心倍率 ────────────────
// 規則：
//   命中率 50% → ×1.0；40% → ×0.8；65% → ×1.3；30% → ×0.6（強烈降權）
//   連續 3 筆 |誤差|>5% → 額外 ×0.7
//   樣本 < 5 → ×1.0（不夠樣本不調整）
// 套用到 winRate：adjusted = 50 + (winRate - 50) × multiplier
export function getConfidenceMultiplier(code) {
  const stats = getStats(code);
  if (!stats || stats.samples < 5) {
    return { multiplier: 1.0, reason: 'samples<5（樣本不足，不調整）', stats };
  }
  let mul = clamp(stats.recentHitRate / 50, 0.4, 1.3);
  let reason = `近期命中率 ${stats.recentHitRate}% → ×${mul.toFixed(2)}`;
  if (stats.consecutiveBigError) {
    mul *= 0.7;
    reason += `；連 3 筆誤差>5% → 額外 ×0.7`;
  }
  return { multiplier: +mul.toFixed(2), reason, stats };
}

// ──────────────── persist / load ────────────────
export function persist() {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    const data = Object.fromEntries(store);
    fs.writeFileSync(STORE_FILE, JSON.stringify(data));
    return store.size;
  } catch (e) {
    console.warn('[predictions persist]', e.message);
    return -1;
  }
}

export function load() {
  try {
    if (!fs.existsSync(STORE_FILE)) return 0;
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(raw || '{}');
    Object.entries(data).forEach(([k, v]) => store.set(k, Array.isArray(v) ? v : []));
    return store.size;
  } catch (e) {
    console.warn('[predictions load]', e.message);
    return 0;
  }
}

export function getAll() {
  return Object.fromEntries(store);
}

export function clear() {
  store.clear();
}
