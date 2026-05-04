// K 線快取 — Supabase 持久化（解 API rate limit / 重啟資料流失）
//
// 設計重點：
//   1. 只儲存 date < today 的「已收盤」資料 — 避免盤中未完成 K 棒污染
//   2. 任一 provider 抓成功 → 背景非阻塞 upsert（fire-and-forget）
//   3. 讀取時加 in-flight 鎖，避免並發 query 重複打 Supabase
//   4. 跑一週後幾乎不需要外網（除了今日新資料）
//
// Schema（請在 Supabase SQL Editor 執行）：
//   CREATE TABLE IF NOT EXISTS kline_cache (
//     code   TEXT NOT NULL,
//     date   DATE NOT NULL,
//     open   NUMERIC,
//     high   NUMERIC,
//     low    NUMERIC,
//     close  NUMERIC NOT NULL,
//     volume INTEGER,
//     source TEXT,                      -- 'cnyes' / 'twse' / 'finmind' / 'stooq' / 'yahoo'
//     cached_at TIMESTAMPTZ DEFAULT NOW(),
//     PRIMARY KEY (code, date)
//   );
//   CREATE INDEX IF NOT EXISTS idx_kline_cache_code ON kline_cache(code);

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

const todayStr = () => new Date().toISOString().slice(0, 10);

// In-flight 鎖（讀）
const inflightLoad = new Map();

// 載入歷史 K 線（Supabase）
// 回傳：[{ date, open, high, low, close, vol, source }] 升冪
export async function loadFromCache(code, daysBack = 100) {
  if (!supabase) return [];
  const key = `kc:${code}:${daysBack}`;
  if (inflightLoad.has(key)) return inflightLoad.get(key);

  const p = (async () => {
    const startDate = new Date(Date.now() - daysBack * 86400e3).toISOString().slice(0, 10);
    try {
      const { data, error } = await supabase
        .from('kline_cache')
        .select('date, open, high, low, close, volume, source')
        .eq('code', code)
        .gte('date', startDate)
        .order('date', { ascending: true });
      if (error) throw error;
      return (data || []).map((r) => ({
        date: r.date,
        open: r.open != null ? +r.open : null,
        high: r.high != null ? +r.high : null,
        low: r.low != null ? +r.low : null,
        close: +r.close,
        vol: r.volume != null ? +r.volume : 0,
        source: r.source,
      })).filter((d) => Number.isFinite(d.close));
    } catch (e) {
      console.warn(`[klineCache load ${code}]`, e.message);
      return [];
    }
  })();
  inflightLoad.set(key, p);
  try { return await p; } finally { inflightLoad.delete(key); }
}

// 儲存 K 線到 Supabase — ★ 只存 date < today 的已收盤資料
// 用 upsert，後到的覆蓋前到的（同 source 多次寫入安全）
export async function saveToCache(code, klineArray, source = 'unknown') {
  if (!supabase || !Array.isArray(klineArray) || !klineArray.length) return 0;
  const today = todayStr();
  const rows = klineArray
    .filter((d) => d && d.date && d.date < today && Number.isFinite(d.close))
    .map((d) => ({
      code,
      date: d.date,
      open: d.open ?? null,
      high: d.high ?? null,
      low: d.low ?? null,
      close: d.close,
      volume: d.vol != null ? Math.round(+d.vol) : (d.volume != null ? Math.round(+d.volume) : null),
      source,
    }));
  if (!rows.length) return 0;
  try {
    const BATCH = 200;
    let total = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const { error } = await supabase
        .from('kline_cache')
        .upsert(chunk, { onConflict: 'code,date' });
      if (error) {
        // schema 缺 source / volume 等欄位 → 先跳過 source 嘗試
        if (/'source'|'volume'/i.test(error.message)) {
          const minimal = chunk.map(({ code: c, date, open, high, low, close }) => ({ code: c, date, open, high, low, close }));
          const r2 = await supabase.from('kline_cache').upsert(minimal, { onConflict: 'code,date' });
          if (r2.error) throw r2.error;
        } else throw error;
      }
      total += chunk.length;
    }
    return total;
  } catch (e) {
    console.warn(`[klineCache save ${code}]`, e.message);
    return -1;
  }
}

export function isConnected() { return !!supabase; }
