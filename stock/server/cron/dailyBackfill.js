// 每日盤後資料 backfill — 離線化資料管線核心
//
// 設計原則：
//   1. 一次抓全市場（不對個股 fan-out）— TWSE OpenAPI 全市場 endpoint 都免 quota
//   2. 所有寫入用 upsert（重跑安全）
//   3. 任一 endpoint 失敗不影響其他（記在 cron_runs.errors）
//   4. 跑完寫 cron_runs，可從 Supabase 看歷史紀錄
//
// 觸發方式：
//   - 啟動時自動補今日（如果今日尚未跑過）
//   - server.js 內建 setInterval 每天 14:35 自動觸發
//   - POST /api/cron/daily-backfill（用 CRON_SECRET 保護，給外部 cron service 觸發）
//   - 手動：node -e "import('./server/cron/dailyBackfill.js').then(m=>m.runDailyBackfill())"

import { createClient } from '@supabase/supabase-js';
import * as twse from '../providers/twse.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

export function isReady() { return !!supabase; }

// ───────────────────────── 日期工具 ─────────────────────────

function todayIso() { return new Date().toISOString().slice(0, 10); }

function isoToCompact(iso) { return iso.replace(/-/g, ''); }

// 給定 ISO 日期，判斷是否為週末（不打 TWSE，省一次 HTTP 並快速失敗）
function isWeekend(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

// 推算「最近一個交易日」— 用於排程錯過時的補抓
// 台灣假日清單未內建（不想 hardcode），交給 TWSE：抓不到就視為非交易日
export function previousBusinessDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

// ───────────────────────── 子任務 ─────────────────────────

// 抓全市場日 K（含個股主檔更新）— TWSE STOCK_DAY_ALL，免 quota，一次 ~1800 檔
// ★ 限制：STOCK_DAY_ALL 只給「今天」的資料、無歷史日期參數，所以 tradeDate 必須是今日
//   要補歷史單日 → 走 STOCK_DAY（單檔逐日，第三刀的歷史回填工具會做）
async function fetchAllKline(tradeDate) {
  if (tradeDate !== todayIso()) {
    throw new Error(`STOCK_DAY_ALL only returns today's snapshot; got tradeDate=${tradeDate}, today=${todayIso()}`);
  }
  const rows = await twse.stockDayAll();
  if (!Array.isArray(rows) || !rows.length) throw new Error('STOCK_DAY_ALL empty');

  const klineRows = [];
  const stockRows = [];
  for (const r of rows) {
    const code = String(r.Code || '').trim();
    if (!/^\d{4,6}$/.test(code)) continue;
    const close = +r.ClosingPrice;
    if (!Number.isFinite(close) || close <= 0) continue;
    const open = +r.OpeningPrice;
    const high = +r.HighestPrice;
    const low = +r.LowestPrice;
    // TradeVolume 為「成交股數」，台股 1 張 = 1000 股
    const volStock = +r.TradeVolume || 0;
    const volLot = Math.round(volStock / 1000);
    klineRows.push({
      code, date: tradeDate,
      open: Number.isFinite(open) ? open : null,
      high: Number.isFinite(high) ? high : null,
      low: Number.isFinite(low) ? low : null,
      close, volume: volLot,
      source: 'twse-stock-day-all',
    });
    stockRows.push({
      code,
      name: String(r.Name || '').trim(),
      market: 'TSE',
      is_etf: /^00/.test(code),
      active: true,
      updated_at: new Date().toISOString(),
    });
  }
  return { klineRows, stockRows };
}

// 抓全市場法人 — TWSE T86，免 quota
async function fetchAllInstitutional(tradeDate) {
  const yyyymmdd = isoToCompact(tradeDate);
  const list = await twse.institutionalByDay(yyyymmdd);
  return list.map((r) => ({
    code: r.code,
    date: tradeDate,
    foreign_net: r.foreign_net,
    trust_net: r.trust_net,
    dealer_net: r.dealer_net,
    total_net: r.total_net,
    source: 'twse-t86',
  }));
}

// 抓全市場融資融券 — TWSE MI_MARGN selectType=ALL
async function fetchAllMargin(tradeDate) {
  const yyyymmdd = isoToCompact(tradeDate);
  const list = await twse.marginByDay(yyyymmdd);
  return list.map((r) => ({
    code: r.code,
    date: tradeDate,
    margin_buy: r.margin_buy,
    margin_sell: r.margin_sell,
    margin_balance: r.margin_balance,
    short_buy: r.short_buy,
    short_sell: r.short_sell,
    short_balance: r.short_balance,
    source: 'twse-mi-margn',
  }));
}

// 抓大盤所有指數收盤 — TWSE MI_INDEX（同 STOCK_DAY_ALL，只給今日快照）
async function fetchAllIndices(tradeDate) {
  if (tradeDate !== todayIso()) {
    throw new Error(`MI_INDEX only returns today's snapshot; got tradeDate=${tradeDate}`);
  }
  const list = await twse.indices();
  if (!Array.isArray(list)) throw new Error('twse indices empty');

  const seen = new Map();
  for (const r of list) {
    const name = String(r.IndexName || r.Name || r.指數名稱 || '').trim();
    if (!name) continue;
    const closeRaw = r.ClosingIndex ?? r.Closing ?? r.收盤指數 ?? r.Close;
    const close = +String(closeRaw ?? '').replace(/,/g, '');
    if (!Number.isFinite(close) || close <= 0) continue;

    // 報酬指數（含股息再投入）跟價格指數要分開存，避免 PK 衝突
    const isReturn = /報酬/.test(name);
    let base;
    if (/^發行量加權股價/.test(name)) base = 'TAIEX';
    else if (/^未含金融保險/.test(name)) base = 'TAIEX_EX_FIN';
    else if (/^未含電子(?!金融)/.test(name)) base = 'TAIEX_EX_ELEC';
    else if (/^未含金融電子/.test(name)) base = 'TAIEX_EX_FIN_ELEC';
    else if (/櫃買|店頭/.test(name)) base = 'OTC';
    else if (/^臺灣?50|^台灣50/.test(name)) base = 'TW50';
    else base = name.replace(/\s+/g, '').replace(/股價指數|指數$/g, '');
    const symbol = isReturn ? `${base}_RTN` : base;
    if (!symbol) continue;

    // 同 (symbol, date) 出現多次時保留第一筆（同一 batch 重複會讓 upsert 整批失敗）
    const key = `${symbol}|${tradeDate}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      symbol,
      date: tradeDate,
      open: null, high: null, low: null,
      close,
      volume: null,
      source: 'twse-mi-index',
    });
  }
  return [...seen.values()];
}

// ───────────────────────── upsert 工具 ─────────────────────────

async function upsertChunked(table, rows, conflict, batch = 500) {
  if (!supabase || !rows.length) return 0;
  let total = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict: conflict });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
    total += chunk.length;
  }
  return total;
}

// 寫入 kline_cache — 直接走 klineCache.saveToCache 的單檔模式不適合「一次全市場」
// 這裡直接 batch upsert（整批已是不同 code 的同一天，不會衝突）
async function saveKlineRows(rows) {
  if (!supabase || !rows.length) return 0;
  const today = todayIso();
  // ★ 過濾：保留今日（含）以前的資料；klineCache.saveToCache 原本擋今日，但 backfill 在 14:35 跑時今日已收盤
  const filtered = rows.filter((r) => Number.isFinite(+r.close));
  return upsertChunked('kline_cache', filtered, 'code,date', 200);
}

// ───────────────────────── 主流程 ─────────────────────────

// 寫一筆 cron_runs（status=running），回傳 id
async function startRun(tradeDate) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('cron_runs')
      .insert({ job: 'daily-backfill', trade_date: tradeDate, status: 'running' })
      .select('id')
      .single();
    if (error) throw error;
    return data?.id || null;
  } catch (e) {
    console.warn('[backfill] startRun failed:', e.message);
    return null;
  }
}

async function finishRun(id, status, stats, errors) {
  if (!supabase || !id) return;
  try {
    await supabase
      .from('cron_runs')
      .update({
        status,
        stats: stats || {},
        errors: errors && Object.keys(errors).length ? errors : null,
        finished_at: new Date().toISOString(),
      })
      .eq('id', id);
  } catch (e) { console.warn('[backfill] finishRun failed:', e.message); }
}

// 取最近 N 筆排程紀錄（給 /api/cron/status 用）
export async function getRecentRuns(limit = 20) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('cron_runs')
      .select('id, job, trade_date, started_at, finished_at, status, stats, errors')
      .order('id', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('[backfill] getRecentRuns:', e.message);
    return [];
  }
}

// 檢查某天某 job 是否已成功跑過（避免同日重跑）
export async function hasRunSuccessfully(tradeDate, job = 'daily-backfill') {
  if (!supabase) return false;
  try {
    const { data, error } = await supabase
      .from('cron_runs')
      .select('id, status')
      .eq('job', job)
      .eq('trade_date', tradeDate)
      .eq('status', 'success')
      .limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch { return false; }
}

// 主入口
// opts:
//   tradeDate: 指定回填某天（'YYYY-MM-DD'）；不傳 = 今日
//   force: true 強制執行（即使該日已成功跑過）
//   skipKline / skipInst / skipMargin / skipIndex: 跳過特定子任務
export async function runDailyBackfill(opts = {}) {
  if (!supabase) {
    return { ok: false, error: 'supabase not configured' };
  }

  const tradeDate = opts.tradeDate || todayIso();

  // 週末直接跳過（避免無謂打 TWSE）
  if (isWeekend(tradeDate)) {
    return { ok: false, skipped: 'weekend', tradeDate };
  }

  // 重複防護
  if (!opts.force && await hasRunSuccessfully(tradeDate)) {
    return { ok: true, skipped: 'already-run', tradeDate };
  }

  const t0 = Date.now();
  const runId = await startRun(tradeDate);
  const stats = { tradeDate };
  const errors = {};

  console.log(`[backfill] start tradeDate=${tradeDate} runId=${runId}`);

  // 階段 1：股票主檔 + 全市場日 K（同一個 endpoint 拿）
  if (!opts.skipKline) {
    try {
      const { klineRows, stockRows } = await fetchAllKline(tradeDate);
      stats.stocksScanned = stockRows.length;
      // 先寫主檔
      const sCount = await upsertChunked('stocks_list', stockRows, 'code', 500);
      stats.stocksUpserted = sCount;
      // 再寫 K 線
      const kCount = await saveKlineRows(klineRows);
      stats.klineRows = kCount;
      console.log(`[backfill] kline ✓ ${kCount} rows (${stockRows.length} stocks)`);
    } catch (e) {
      errors.kline = e.message;
      console.warn(`[backfill] kline ✗ ${e.message}`);
    }
  }

  // 階段 2：全市場法人
  if (!opts.skipInst) {
    try {
      const rows = await fetchAllInstitutional(tradeDate);
      const n = await upsertChunked('daily_institutional', rows, 'code,date', 500);
      stats.instRows = n;
      console.log(`[backfill] institutional ✓ ${n} rows`);
    } catch (e) {
      errors.institutional = e.message;
      console.warn(`[backfill] institutional ✗ ${e.message}`);
    }
  }

  // 階段 3：全市場融資融券
  if (!opts.skipMargin) {
    try {
      const rows = await fetchAllMargin(tradeDate);
      const n = await upsertChunked('daily_margin', rows, 'code,date', 500);
      stats.marginRows = n;
      console.log(`[backfill] margin ✓ ${n} rows`);
    } catch (e) {
      errors.margin = e.message;
      console.warn(`[backfill] margin ✗ ${e.message}`);
    }
  }

  // 階段 4：大盤指數
  if (!opts.skipIndex) {
    try {
      const rows = await fetchAllIndices(tradeDate);
      const n = await upsertChunked('daily_index', rows, 'symbol,date', 200);
      stats.indexRows = n;
      console.log(`[backfill] indices ✓ ${n} rows`);
    } catch (e) {
      errors.indices = e.message;
      console.warn(`[backfill] indices ✗ ${e.message}`);
    }
  }

  stats.elapsedMs = Date.now() - t0;
  const errorCount = Object.keys(errors).length;
  const status = errorCount === 0 ? 'success' : (stats.klineRows || stats.instRows ? 'partial' : 'failed');
  await finishRun(runId, status, stats, errors);

  console.log(`[backfill] done status=${status} elapsed=${stats.elapsedMs}ms`);
  return { ok: status !== 'failed', status, tradeDate, stats, errors };
}
