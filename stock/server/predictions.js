// 預測追蹤 / 自我學習回饋迴路（Supabase backed）
//
// ───── 架構 ─────
//   一級存放：in-memory Map（同步讀寫，API 回應不阻塞）
//   二級存放：Supabase Postgres（持久化，跨 redeploy 保留）
//
//   寫路徑：record() → 更新 Map（同步） → markDirty() → 排程 flushDirty()（背景）
//   讀路徑：getStats() / getConfidenceMultiplier() 直接讀 Map（同步、零網路）
//   啟動：load() 一次拉下全部歷史 → 灌入 Map
//   關機：persist() 強制 flush 待寫 queue
//
// ───── Supabase 資料表 schema（建議） ─────
//   CREATE TABLE IF NOT EXISTS predictions (
//     code            TEXT    NOT NULL,
//     date            DATE    NOT NULL,
//     close           NUMERIC NOT NULL,
//     win_rate        INTEGER,
//     direction       TEXT,
//     target1         NUMERIC,
//     stop            NUMERIC,
//     expected_return NUMERIC,
//     recorded_at     BIGINT,
//     validated       BOOLEAN DEFAULT FALSE,
//     actual_close    NUMERIC,
//     actual_date     DATE,
//     actual_return   NUMERIC,
//     direction_hit   BOOLEAN,
//     expected_error  NUMERIC,
//     abs_error       NUMERIC,
//     PRIMARY KEY (code, date)
//   );
//   CREATE INDEX IF NOT EXISTS idx_predictions_code ON predictions(code);
//   CREATE INDEX IF NOT EXISTS idx_predictions_validated ON predictions(validated);

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });
}

// 結構：Map<code, [{date, close, winRate, direction, target1, expectedReturn, validated, ...}]>
const store = new Map();
// 待 flush 的 (code|date) key
const dirtyKeys = new Set();
// 排程器
let flushTimer = null;
let flushInFlight = false;

const HOLD_DAYS = 5;
const MAX_PER_STOCK = 90;
const RECENT_WINDOW = 20;
const FLUSH_DELAY_MS = 2000;   // record/validate 後 2 秒 debounce flush
const PAGE_SIZE = 1000;        // Supabase 分頁

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ───────────── camelCase ↔ snake_case 對映 ─────────────
function toRow(code, p) {
  return {
    code,
    date: p.date,
    close: p.close,
    win_rate: p.winRate ?? null,
    direction: p.direction ?? null,
    target1: p.target1 ?? null,
    stop: p.stop ?? null,
    expected_return: p.expectedReturn ?? null,
    recorded_at: p.recordedAt ?? Date.now(),
    validated: p.validated || false,
    actual_close: p.actualClose ?? null,
    actual_date: p.actualDate ?? null,
    actual_return: p.actualReturn ?? null,
    direction_hit: p.directionHit ?? null,
    expected_error: p.expectedError ?? null,
    abs_error: p.absError ?? null,
  };
}

function fromRow(r) {
  return {
    date: r.date,
    close: r.close != null ? +r.close : null,
    winRate: r.win_rate,
    direction: r.direction,
    target1: r.target1 != null ? +r.target1 : null,
    stop: r.stop != null ? +r.stop : null,
    expectedReturn: r.expected_return != null ? +r.expected_return : null,
    recordedAt: r.recorded_at != null ? +r.recorded_at : Date.now(),
    validated: !!r.validated,
    actualClose: r.actual_close != null ? +r.actual_close : null,
    actualDate: r.actual_date,
    actualReturn: r.actual_return != null ? +r.actual_return : null,
    directionHit: r.direction_hit,
    expectedError: r.expected_error != null ? +r.expected_error : null,
    absError: r.abs_error != null ? +r.abs_error : null,
  };
}

// ───────────── dirty queue + 背景 flush ─────────────
function markDirty(code, date) {
  if (code && date) dirtyKeys.add(`${code}|${date}`);
}

function scheduleFlush() {
  if (!supabase || flushTimer || flushInFlight) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDirty().catch((e) => console.warn('[predictions flush]', e.message));
  }, FLUSH_DELAY_MS);
}

async function flushDirty() {
  if (!supabase || !dirtyKeys.size || flushInFlight) return 0;
  flushInFlight = true;

  // Snapshot dirty set，flush 期間若有新 dirty 也不會丟（會在下次 schedule 處理）
  const snapshot = [...dirtyKeys];
  dirtyKeys.clear();

  const rows = [];
  for (const key of snapshot) {
    const [code, date] = key.split('|');
    const arr = store.get(code) || [];
    const p = arr.find((x) => x.date === date);
    if (p) rows.push(toRow(code, p));
  }
  if (!rows.length) {
    flushInFlight = false;
    return 0;
  }

  try {
    // 分批 upsert（避免單次 payload 過大）
    const BATCH = 500;
    let total = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const { error } = await supabase
        .from('predictions')
        .upsert(chunk, { onConflict: 'code,date' });
      if (error) throw error;
      total += chunk.length;
    }
    flushInFlight = false;
    return total;
  } catch (e) {
    // 失敗：把 key 放回 dirty queue 等下次重試
    snapshot.forEach((k) => dirtyKeys.add(k));
    flushInFlight = false;
    console.warn('[predictions upsert]', e.message);
    return -1;
  }
}

// ───────────── record（同步，立即可讀） ─────────────
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
    // 已驗證的不要被覆蓋為未驗證；其他欄位以最新為準
    if (arr[idx].validated) {
      entry.validated = true;
      entry.actualClose = arr[idx].actualClose;
      entry.actualDate = arr[idx].actualDate;
      entry.actualReturn = arr[idx].actualReturn;
      entry.directionHit = arr[idx].directionHit;
      entry.expectedError = arr[idx].expectedError;
      entry.absError = arr[idx].absError;
    }
    arr[idx] = entry;
  } else {
    arr.push(entry);
  }
  if (arr.length > MAX_PER_STOCK) arr.splice(0, arr.length - MAX_PER_STOCK);
  store.set(code, arr);

  markDirty(code, today);
  scheduleFlush();
}

// ───────────── validate（同步，把 hit/miss 寫入 memory，背景 sync 至 DB） ─────────────
export function validate(code, kline) {
  if (!Array.isArray(kline) || kline.length < HOLD_DAYS + 1) return 0;
  const arr = store.get(code);
  if (!arr || !arr.length) return 0;

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

    const startIdx = datesAsc.findIndex((d) => d > p.date);
    if (startIdx < 0) continue;
    const targetIdx = startIdx + HOLD_DAYS - 1;
    if (targetIdx >= datesAsc.length) continue;

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
    markDirty(code, p.date);
  }
  if (validatedCount) {
    store.set(code, arr);
    scheduleFlush();
  }
  return validatedCount;
}

// ───────────── 統計 / 信心倍率（純記憶體，同步） ─────────────
export function getStats(code) {
  const arr = store.get(code);
  if (!arr || !arr.length) {
    return { samples: 0, totalRecorded: 0, recentSampleCount: 0, recentHitRate: null, mae: null, consecutiveBigError: false, last: null, pending: 0 };
  }
  const validated = arr.filter((p) => p.validated && p.directionHit != null);
  const totalRecorded = arr.length;
  const pending = arr.filter((p) => !p.validated).length;
  if (!validated.length) {
    return { samples: 0, totalRecorded, pending, recentSampleCount: 0, recentHitRate: null, mae: null, consecutiveBigError: false, last: null };
  }

  const recent = validated.slice(-RECENT_WINDOW);
  const hits = recent.filter((p) => p.directionHit).length;
  const recentHitRate = +((hits / recent.length) * 100).toFixed(1);
  const errors = recent.map((p) => p.absError).filter((e) => e != null);
  const mae = errors.length ? +(errors.reduce((s, e) => s + e, 0) / errors.length).toFixed(2) : null;

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
    pending,
    recentSampleCount: recent.length,
    recentHitRate,
    mae,
    consecutiveBigError,
    last,
  };
}

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

// ───────────── load（啟動時：Supabase → Map） ─────────────
export async function load() {
  if (!supabase) {
    console.warn('[predictions] SUPABASE_URL/SUPABASE_KEY 未設定，純記憶體模式啟動');
    return 0;
  }
  try {
    const all = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('predictions')
        .select('*')
        .order('date', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      all.push(...data);
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    // 按 code group + 截斷 + 灌入 store
    const grouped = new Map();
    for (const r of all) {
      const arr = grouped.get(r.code) || [];
      arr.push(fromRow(r));
      grouped.set(r.code, arr);
    }
    store.clear();
    for (const [code, arr] of grouped) {
      arr.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      if (arr.length > MAX_PER_STOCK) arr.splice(0, arr.length - MAX_PER_STOCK);
      store.set(code, arr);
    }
    return store.size;
  } catch (e) {
    console.warn('[predictions load]', e.message);
    return 0;
  }
}

// ───────────── persist（強制 flush 待寫 queue） ─────────────
export async function persist() {
  if (!supabase) return -1;
  // 取消排程的 timer，直接強制 flush
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  // 等待 in-flight 完成（最多 5 秒）避免重複寫
  const t0 = Date.now();
  while (flushInFlight && Date.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return await flushDirty();
}

// ───────────── debug helpers ─────────────
export function getAll() {
  return Object.fromEntries(store);
}

export function clear() {
  store.clear();
  dirtyKeys.clear();
}

export function status() {
  return {
    supabaseConnected: !!supabase,
    stocksTracked: store.size,
    totalPredictions: [...store.values()].reduce((s, arr) => s + arr.length, 0),
    dirtyPending: dirtyKeys.size,
    flushInFlight,
  };
}
