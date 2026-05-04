import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memo } from './cache.js';
import { getSession, todayIso, todayCompact } from './session.js';
import * as twse from './providers/twse.js';
import * as twseMis from './providers/twseMis.js';
import * as finmind from './providers/finmind.js';
import * as yahoo from './providers/yahoo.js';
import * as stooq from './providers/stooq.js';
import * as cnyes from './providers/cnyes.js';
import { diagnose } from '../src/utils/diagnose.js';
import { newsSentiment } from '../src/utils/sentiment.js';
import * as predictions from './predictions.js';
import * as portfolio from './portfolio.js';
import { getMarketContext } from './marketContext.js';
import { getIndustryStatsFor } from './industryContext.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = +(process.env.PORT || 5174);
const TTL_HIST = +(process.env.CACHE_TTL_HISTORICAL_MS || 86400000);
const TTL_LIVE = +(process.env.CACHE_TTL_REALTIME_MS || 5000);
finmind.setToken(process.env.FINMIND_TOKEN);

const app = express();
app.use(express.json());

// 靜態前端：index.html / src / styles.css
app.use(express.static(ROOT, {
  setHeaders: (res, p) => {
    if (p.endsWith('.js')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ───────────────────────── helpers ─────────────────────────

function ok(res, data) { res.json({ ok: true, data, ts: Date.now() }); }
function fail(res, err, code = 502) {
  console.warn('[fail]', err?.message || err);
  res.status(code).json({ ok: false, error: String(err?.message || err) });
}

// race + fallback：依序嘗試多個 provider
async function chain(...fns) {
  const errors = [];
  for (const fn of fns) {
    try { return await fn(); }
    catch (e) { errors.push(e.message); }
  }
  throw new Error('all providers failed: ' + errors.join(' | '));
}

// ───────────────────────── meta ─────────────────────────

app.get('/api/health', (_req, res) => ok(res, { session: getSession(), today: todayIso() }));

// 診斷：直接打三個 provider，回原始狀態。瀏覽器開 /api/diag 看
app.get('/api/diag', async (_req, res) => {
  const out = {
    session: getSession(),
    today: todayIso(),
    serverTime: new Date().toISOString(),
    mis: {},
    stooq: {},
    yahoo: {},
    finmind: {},
    twse: {},
  };

  // Stooq 國際指數
  try {
    const t0 = Date.now();
    const r = await stooq.quotes(['^SOX', '^IXIC', '^GSPC', '^DJI']);
    out.stooq.indices = {
      ms: Date.now() - t0,
      results: r.map((q) => ({
        symbol: q.symbol,
        displayName: q.displayName,
        ok: !!(q && q.price != null),
        price: q?.price,
        prevClose: q?.prevClose,
        error: q?.error,
      })),
    };
  } catch (e) { out.stooq.error = e.message; }

  // TWSE MIS: 個股 + 大盤
  try {
    const t0 = Date.now();
    const r = await twseMis.quotes(['2330'], 'tse');
    out.mis['2330'] = {
      ms: Date.now() - t0,
      ok: !!(r[0] && r[0].price != null),
      price: r[0]?.price,
      last: r[0]?.last,
      bestBid: r[0]?.bestBid,
      bestAsk: r[0]?.bestAsk,
      time: r[0]?.time,
      error: r[0]?.error,
    };
  } catch (e) { out.mis.error = e.message; }
  try {
    const t0 = Date.now();
    const idx = await twseMis.indices();
    out.mis['^TAIEX'] = {
      ms: Date.now() - t0,
      ok: !!idx.taiex,
      price: idx.taiex?.price,
      pct: idx.taiex?.pct?.toFixed(2),
    };
  } catch (e) { out.mis.indicesError = e.message; }

  // Yahoo: 試 2330.TW
  try {
    const t0 = Date.now();
    const q = await yahoo.quotes(['2330.TW']);
    out.yahoo['2330.TW'] = {
      ms: Date.now() - t0,
      ok: !!(q[0] && q[0].price != null),
      price: q[0]?.price,
      prevClose: q[0]?.prevClose,
      time: q[0]?.time && new Date(q[0].time * 1000).toISOString(),
      error: q[0]?.error,
    };
  } catch (e) { out.yahoo.error = e.message; }

  // Yahoo: 試 ^TWII
  try {
    const t0 = Date.now();
    const q = await yahoo.quotes(['^TWII']);
    out.yahoo['^TWII'] = {
      ms: Date.now() - t0,
      ok: !!(q[0] && q[0].price != null),
      price: q[0]?.price,
      prevClose: q[0]?.prevClose,
      error: q[0]?.error,
    };
  } catch (e) { out.yahoo.twiiError = e.message; }

  // FinMind: 試 2330 今日
  try {
    const t0 = Date.now();
    const r = await finmind.stockPrice('2330', todayIso());
    out.finmind['2330'] = { ms: Date.now() - t0, count: r.length, last: r[r.length - 1] };
  } catch (e) { out.finmind.error = e.message; }

  // TWSE: 試大盤指數
  try {
    const t0 = Date.now();
    const r = await twse.indices();
    out.twse.indices = { ms: Date.now() - t0, count: r.length };
  } catch (e) { out.twse.error = e.message; }

  ok(res, out);
});

// ───────────────────────── 大盤指數 ─────────────────────────
// TAIEX / OTC：盤中走 FinMind，盤後也可走 TWSE MI_INDEX
// SOX / NDX / SPX：Yahoo
app.get('/api/indices', async (_req, res) => {
  try {
    // indices cache 1.5 秒（前端打 3 秒，server 確保不過頻打外部 API）
    const data = await memo('indices', 1500, async () => {
      const session = getSession();
      // 台股
      const tw = await chain(
        // 主源：TWSE MIS（台灣本地秒級即時）
        async () => {
          const mis = await twseMis.indices();
          const norm = (r) => {
            if (!r || r.price == null) return null;
            return {
              close: r.price,
              change: r.chg,
              pct: r.pct,
              source: 'twse-mis',
            };
          };
          const taiex = norm(mis.taiex);
          const otc = norm(mis.otc);
          if (!taiex) throw new Error('mis no TAIEX');
          return { taiex, otc };
        },
        // 備援 1：Yahoo ^TWII（盤中也即時）
        async () => {
          const yh = await yahoo.quotes(['^TWII', '^TWOII']);
          const norm = (q) => {
            if (!q || q.price == null || q.prevClose == null) return null;
            return {
              close: q.price,
              change: q.price - q.prevClose,
              pct: q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : 0,
              source: 'yahoo',
            };
          };
          const taiex = norm(yh[0]);
          const otc = norm(yh[1]);
          if (!taiex) throw new Error('yahoo no TWII');
          return { taiex, otc };
        },
        // 備援 2：TWSE OpenAPI（盤後）
        async () => {
          const rows = await twse.indices();
          const find = (n) => rows.find((r) => r.指數 === n);
          const taiex = find('發行量加權股價指數');
          const otc = find('未含金融保險股指數');
          return {
            taiex: taiex && {
              close: +taiex.收盤指數,
              change: (taiex.漲跌 === '-' ? -1 : 1) * +taiex.漲跌點數,
              pct: (taiex.漲跌 === '-' ? -1 : 1) * +taiex.漲跌百分比,
              source: 'twse',
            },
            otc: otc && {
              close: +otc.收盤指數,
              change: (otc.漲跌 === '-' ? -1 : 1) * +otc.漲跌點數,
              pct: (otc.漲跌 === '-' ? -1 : 1) * +otc.漲跌百分比,
              source: 'twse',
            },
          };
        },
      );

      // 國際指數：Stooq 主源（無 token 無 rate limit），Yahoo 備援（429 風險）
      // cache 60 秒：避免太頻繁打外站
      const intl = await memo('intl', 60000, async () => {
        // 主源 Stooq
        try {
          const stooqResults = await stooq.quotes(['^SOX', '^IXIC', '^GSPC', '^DJI']);
          if (stooqResults.some((q) => q && q.price != null)) return stooqResults;
        } catch (e) { console.warn('[stooq intl]', e.message); }
        // 備援 Yahoo
        return yahoo.quotes(['^SOX', '^IXIC', '^GSPC', '^DJI']);
      });
      const norm = (q) => {
        if (!q || q.price == null || q.prevClose == null) return null;
        return {
          close: q.price,
          change: q.price - q.prevClose,
          pct: q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : 0,
          symbol: q.symbol,
          displayName: q.displayName,
          source: q.source,
        };
      };
      const m = Object.fromEntries(intl.filter(Boolean).map((q) => [q.symbol, norm(q)]));

      return {
        session,
        taiex: tw.taiex || null,
        otc: tw.otc || null,
        sox: m['^SOX'] || null,
        ixic: m['^IXIC'] || null,
        gspc: m['^GSPC'] || null,
        dji: m['^DJI'] || null,
      };
    });
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 個股清單（基本資料）─────────────────────────

app.get('/api/stocks', async (_req, res) => {
  try {
    const data = await memo('stockInfo', TTL_HIST, () => finmind.stockInfo());
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 個股 K 線 ─────────────────────────

app.get('/api/kline/:code', async (req, res) => {
  const code = req.params.code;
  const days = +(req.query.days || 90);
  const end = todayIso();
  const start = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  try {
    let data = null;
    // 主源：FinMind
    try {
      data = await memo(`kline:${code}:${days}`, TTL_LIVE * 60, () => finmind.stockPrice(code, start, end));
      if (!data || data.length < 30) data = null;
    } catch (e) {
      console.warn(`[kline ${code}] finmind:`, e.message);
    }
    // 備援 1：Yahoo chart
    if (!data) {
      try {
        const yh = await memo(`yhKline:${code}:${days}`, 5 * 60 * 1000, () => yahoo.chart(`${code}.TW`, '3mo', '1d'));
        if (yh && yh.length >= 30) {
          data = yh.map((d) => ({
            date: d.date, open: d.open, max: d.high, min: d.low, close: d.close,
            Trading_Volume: Math.round((d.volume || 0) / 1000),
          }));
        }
      } catch (e) { console.warn(`[kline ${code}] yahoo:`, e.message); }
    }
    // 備援 2：TWSE STOCK_DAY（用戶 diag 顯示 TWSE 穩定 — 主要 TW backup）
    if (!data) {
      try {
        const tw = await memo(`twseDay:${code}:${days}`, 24 * 60 * 60 * 1000, () => twse.stockDayHistory(code, days));
        if (tw && tw.length >= 30) {
          data = tw.map((d) => ({
            date: d.date, open: d.open, max: d.high, min: d.low, close: d.close,
            Trading_Volume: d.volume,
          }));
        }
      } catch (e) { console.warn(`[kline ${code}] twse:`, e.message); }
    }
    // 備援 3：Stooq CSV（最後防線）
    if (!data) {
      try {
        const sq = await memo(`sqKline:${code}:${days}`, 30 * 60 * 1000, () => stooq.chart(`${code}.tw`, Math.max(days, 100)));
        if (sq && sq.length >= 30) {
          data = sq.map((d) => ({
            date: d.date, open: d.open, max: d.high, min: d.low, close: d.close,
            Trading_Volume: Math.round((d.volume || 0) / 1000),
          }));
        }
      } catch (e) { console.warn(`[kline ${code}] stooq:`, e.message); }
    }
    if (!data) throw new Error('K 線資料不可用（FinMind / Yahoo / TWSE / Stooq 全失敗）');
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 個股即時報價批次 ─────────────────────────
// 主源：TWSE MIS → Yahoo → FinMind cache
// 加固：last-known-good 快取 + freshness 檢查 + 異常跳價過濾
const lastGoodQuotes = new Map();      // code → { price, prev, chg, pct, ts, source }
// 註：原本有 anomaly 檢查（跳價 > 7% 視為錯誤資料），但 scheduler poll 間隔正好 = 30s 窗口，
// 漲停（+9.97%）會被誤判而卡住，已拿掉。lastGoodQuotes 只用於來源全失敗時的 stillMissing fallback。
// 台股跳動單位 round（修正 Yahoo/Stooq 偶爾回不合法價格如 242.13）
function roundToTwTick(p) {
  if (p == null || !Number.isFinite(+p)) return p;
  const v = +p;
  if (v < 10)   return Math.round(v * 100) / 100;
  if (v < 50)   return Math.round(v * 20) / 20;
  if (v < 100)  return Math.round(v * 10) / 10;
  if (v < 500)  return Math.round(v * 2) / 2;
  if (v < 1000) return Math.round(v);
  return Math.round(v / 5) * 5;
}

function applyQuoteGuard(code, q) {
  if (!q || q.price == null) return null;
  // 只做台股跳動單位 round，不做 anomaly 攔截（漲停會被誤判）
  const normalized = {
    ...q,
    price: roundToTwTick(q.price),
    prev: roundToTwTick(q.prev),
    open: q.open != null ? roundToTwTick(q.open) : undefined,
    dayHigh: q.dayHigh != null ? roundToTwTick(q.dayHigh) : undefined,
    dayLow: q.dayLow != null ? roundToTwTick(q.dayLow) : undefined,
  };
  if (Number.isFinite(normalized.price) && Number.isFinite(normalized.prev) && normalized.prev > 0) {
    normalized.chg = +(normalized.price - normalized.prev).toFixed(2);
    normalized.pct = +(((normalized.price - normalized.prev) / normalized.prev) * 100).toFixed(2);
  }
  const guarded = { ...normalized, ts: Date.now() };
  lastGoodQuotes.set(code, guarded);
  return guarded;
}

app.get('/api/quotes/batch', async (req, res) => {
  const codes = (req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!codes.length) return ok(res, {});
  try {
    const session = getSession();
    const out = {};
    const errors = {};

    // ─ 主源：TWSE MIS（cache 1 秒，含異常偵測與 last-good guard）─
    try {
      const misResults = await memo(`mis:${codes.join(',')}`, 1000, () => twseMis.quotes(codes, 'tse'));
      misResults.forEach((r) => {
        if (!r || r.error || r.price == null) {
          if (r?.error) errors[r.code] = r.error;
          return;
        }
        const raw = {
          price: r.price, prev: r.prevClose, chg: r.chg, pct: r.pct,
          open: r.open, dayHigh: r.high, dayLow: r.low,
          volume: r.volume, bestBid: r.bestBid, bestAsk: r.bestAsk,
          bid: r.bid, ask: r.ask, bidVol: r.bidVol, askVol: r.askVol,
          limitUp: r.limitUp, limitDown: r.limitDown, time: r.time,
          source: 'twse-mis',
        };
        const guarded = applyQuoteGuard(r.code, raw);
        if (guarded) out[r.code] = guarded;
      });
    } catch (e) {
      console.warn('[mis batch]', e.message);
      errors._mis = e.message;
    }

    // ─ 備援 1：Yahoo（給 MIS 沒回的）─
    const missingAfterMis = codes.filter((c) => !out[c]);
    if (missingAfterMis.length) {
      try {
        const symbols = missingAfterMis.map((c) => `${c}.TW`);
        const yhResults = await memo(`yhBatch:${symbols.join(',')}`, TTL_LIVE, () => yahoo.quotes(symbols));
        yhResults.forEach((q, i) => {
          const code = missingAfterMis[i];
          if (!q || q.error || q.price == null) return;
          const close = q.price;
          const prev = q.prevClose ?? close;
          const raw = {
            price: close, prev,
            chg: close - prev,
            pct: prev ? ((close - prev) / prev) * 100 : 0,
            dayHigh: q.dayHigh, dayLow: q.dayLow, volume: q.volume,
            time: q.time, source: 'yahoo',
          };
          const guarded = applyQuoteGuard(code, raw);
          if (guarded) out[code] = guarded;
        });
      } catch (e) { errors._yahoo = e.message; }
    }

    // ─ 最後防線：對仍 missing 的代碼套用 last-known-good ─
    const stillMissing = codes.filter((c) => !out[c]);
    for (const c of stillMissing) {
      const last = lastGoodQuotes.get(c);
      if (last && Date.now() - last.ts < 5 * 60 * 1000) {  // 5 分鐘內的 last good 還算有效
        out[c] = { ...last, source: last.source + '-stale', stale: true };
      }
    }

    // ─ 備援 2：FinMind cache（盤中不發新請求）─
    const missingFinal = codes.filter((c) => !out[c]);
    if (missingFinal.length) {
      const isLive = session === 'live' || session === 'pre';
      const { get } = await import('./cache.js');
      for (const c of missingFinal) {
        try {
          const cached = get(`miniK:${c}`);
          let arr = cached;
          if (!arr && !isLive) {
            const start = new Date(Date.now() - 10 * 86400e3).toISOString().slice(0, 10);
            arr = await memo(`miniK:${c}`, TTL_HIST / 24, () => finmind.stockPrice(c, start));
          }
          if (!arr || arr.length < 2) { errors[c] = errors[c] || 'all sources failed'; continue; }
          const last = arr[arr.length - 1];
          const prev = arr[arr.length - 2];
          out[c] = {
            price: +last.close,
            prev: +prev.close,
            chg: +last.close - +prev.close,
            pct: prev.close ? ((+last.close - +prev.close) / +prev.close) * 100 : 0,
            date: last.date,
            source: 'finmind',
          };
        } catch (e) { errors[c] = e.message; }
      }
    }

    ok(res, { session, quotes: out, errors });
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 個股盤中快照 ─────────────────────────

app.get('/api/quote/:code', async (req, res) => {
  const code = req.params.code;
  try {
    const data = await memo(`quote:${code}`, TTL_LIVE, async () => {
      try { return { source: 'finmind', tick: await finmind.tickSnapshot(code) }; }
      catch { return { source: 'yahoo', quote: (await yahoo.quotes([`${code}.TW`]))[0] }; }
    });
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 個股三大法人（近 30 日）─────────────────────────
// 回傳每筆 row 加上 trustPctOfCap = (該日投信淨買股數 / 流通股數) × 100

app.get('/api/institutional/:code', async (req, res) => {
  const code = req.params.code;
  const start = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
  try {
    // FinMind 失敗 → TWSE T86 fallback
    let rawInst = null;
    try {
      rawInst = await memo(`inst:${code}`, TTL_HIST / 24, () => finmind.institutional(code, start));
    } catch (e) { console.warn(`[inst ${code}] finmind:`, e.message); }
    if (!rawInst || !rawInst.length) {
      try {
        rawInst = await memo(`twseInst:${code}:30`, 60 * 60 * 1000, () => twse.institutionalRecentForCode(code, 30));
      } catch (e) { console.warn(`[inst ${code}] twse T86:`, e.message); }
    }
    const sh = await memo(`shares:${code}`, TTL_HIST, () => finmind.sharesOutstanding(code).catch(() => null)).catch(() => null);
    const cap = sh && sh.sharesOutstanding ? +sh.sharesOutstanding : null;
    const data = (rawInst || []).map((r) => {
      if (!cap || !r.name?.includes('投信')) return r;
      const net = (+r.buy || 0) - (+r.sell || 0);
      return { ...r, trustPctOfCap: (net / cap) * 100 };
    });
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 個股基本面整合 ─────────────────────────
// 整合：TWSE BWIBBU_ALL（PE/PB/殖利率）+ FinMind financial（EPS/毛利/營益）+ shareholding（市值/外資 %）
app.get('/api/fundamentals/:code', async (req, res) => {
  const code = req.params.code;
  try {
    const data = await memo(`fund:${code}`, TTL_HIST / 24, async () => {
      const out = { code };

      // 1. TWSE BWIBBU_ALL — PE / PB / 殖利率（每日更新）
      try {
        const all = await memo('bwibbu:all', TTL_HIST / 24, () => twse.bwibbu());
        const r = all.find((x) => x.Code === code);
        if (r) {
          out.pe = +r.PEratio || null;
          out.pb = +r.PBratio || null;
          out.divYield = +r.DividendYield || null;
        }
      } catch (e) { out.bwibbuError = e.message; }

      // 2. FinMind shareholding — 流通股數 + 外資持股 %
      try {
        const start = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
        const sh = await memo(`shareholdingRaw:${code}`, TTL_HIST, () =>
          finmind.majorShareholder ? null : null  // 用下面那個更準確的
        ).catch(() => null);

        // FinMind TaiwanStockShareholding 直接呼叫拿外資 %
        const shRows = await memo(`shareholding-raw:${code}`, TTL_HIST / 24, async () => {
          const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockShareholding&data_id=${code}&start_date=${start}`;
          const headers = process.env.FINMIND_TOKEN ? { Authorization: `Bearer ${process.env.FINMIND_TOKEN}` } : {};
          const r = await fetch(url, { headers });
          if (!r.ok) throw new Error(`finmind shareholding HTTP ${r.status}`);
          const j = await r.json();
          if (j.status !== 200) throw new Error(`finmind ${j.msg}`);
          return j.data || [];
        });
        const latestSh = shRows[shRows.length - 1];
        if (latestSh) {
          out.foreignPct = +latestSh.ForeignInvestmentSharesRatio || null;
          out.sharesOutstanding = +latestSh.NumberOfSharesIssued || null;
          out.foreignRemainPct = +latestSh.ForeignInvestmentRemainRatio || null;
          out.shareDate = latestSh.date;
        }
      } catch (e) { out.shareholdingError = e.message; }

      // 3. FinMind financial — EPS（近 4 季 TTM）、毛利率、營益率、ROE
      try {
        const finStart = new Date(Date.now() - 2 * 365 * 86400e3).toISOString().slice(0, 10);
        const fin = await memo(`fin-raw:${code}`, TTL_HIST, () => finmind.financial(code, finStart));

        // 取最近 4 季 EPS 加總（TTM）
        const epsRows = (fin || []).filter((r) => r.type === 'EPS' || r.type === 'BasicEPS')
          .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        if (epsRows.length >= 4) {
          out.epsTTM = epsRows.slice(-4).reduce((sum, r) => sum + (+r.value || 0), 0);
          out.epsLastQ = +epsRows[epsRows.length - 1].value;
        } else if (epsRows.length) {
          out.epsLastQ = +epsRows[epsRows.length - 1].value;
        }

        // 最近一季 毛利率 / 營益率 / ROE
        const lastDate = (fin || []).map((r) => r.date).sort().pop();
        if (lastDate) {
          const last = (fin || []).filter((r) => r.date === lastDate);
          const findVal = (...types) => {
            for (const t of types) {
              const row = last.find((r) => r.type === t);
              if (row && Number.isFinite(+row.value)) return +row.value;
            }
            return null;
          };
          const rev = findVal('Revenue', 'OperatingRevenue');
          const grossProfit = findVal('GrossProfit');
          const operatingIncome = findVal('OperatingIncome', 'OperatingProfit');
          const netIncome = findVal('IncomeAfterTaxes', 'EAT', 'NetIncome');
          const equity = findVal('Equity', 'TotalEquity', 'StockHoldersEquity');

          if (rev && grossProfit) out.gpm = (grossProfit / rev) * 100;
          if (rev && operatingIncome) out.opm = (operatingIncome / rev) * 100;
          if (netIncome && equity) out.roe = (netIncome / equity) * 100 * 4; // 季 → 年化（粗略）
          out.financialDate = lastDate;
        }
      } catch (e) { out.financialError = e.message; }

      // 4. 市值 = 當前股價 × 流通股數
      try {
        const mis = await memo(`mis:${code}`, 1000, () => twseMis.quotes([code], 'tse'));
        const m = mis[0];
        if (m && m.price && out.sharesOutstanding) {
          out.mcap = m.price * out.sharesOutstanding;
        }
      } catch (e) { out.misError = e.message; }

      return out;
    });
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 流通股數 ─────────────────────────

app.get('/api/shareholding/:code', async (req, res) => {
  const code = req.params.code;
  try {
    const data = await memo(`shares:${code}`, TTL_HIST, () => finmind.sharesOutstanding(code));
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 大戶／散戶持股結構 ─────────────────────────

app.get('/api/shareholders/:code', async (req, res) => {
  const code = req.params.code;
  const start = new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);
  try {
    const data = await memo(`shrholders:${code}`, TTL_HIST / 12, () => finmind.majorShareholder(code, start));
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 個股融資融券 ─────────────────────────

app.get('/api/margin/:code', async (req, res) => {
  const code = req.params.code;
  const start = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
  try {
    const data = await memo(`margin:${code}`, TTL_HIST / 24, () => finmind.margin(code, start));
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 月營收 ─────────────────────────

app.get('/api/revenue/:code', async (req, res) => {
  const code = req.params.code;
  const start = new Date(Date.now() - 24 * 30 * 86400e3).toISOString().slice(0, 10);
  try {
    const data = await memo(`rev:${code}`, TTL_HIST, () => finmind.monthRevenue(code, start));
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 財報 ─────────────────────────

app.get('/api/financial/:code', async (req, res) => {
  const code = req.params.code;
  const start = new Date(Date.now() - 5 * 365 * 86400e3).toISOString().slice(0, 10);
  try {
    const data = await memo(`fin:${code}`, TTL_HIST, () => finmind.financial(code, start));
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 盤後精準資料（TWSE）─────────────────────────

app.get('/api/postmarket/summary', async (_req, res) => {
  try {
    const data = await memo('postmarket', TTL_HIST / 48, async () => {
      const out = { date: todayCompact(), errors: {} };
      const tasks = [
        ['indices', () => twse.indices()],
        ['stockDay', () => twse.stockDayAll()],
        ['institutional', () => twse.institutional()],
        ['institutionalByStock', () => twse.institutionalByStock()],
        ['margin', () => twse.margin()],
        ['bwibbu', () => twse.bwibbu()],
        ['topGainers', () => twse.topGainers()],
      ];
      const results = await Promise.allSettled(tasks.map(([_, fn]) => fn()));
      results.forEach((r, i) => {
        const key = tasks[i][0];
        if (r.status === 'fulfilled') out[key] = r.value;
        else out.errors[key] = r.reason?.message;
      });
      return out;
    });
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 強弱榜（依當日 K 線排序）─────────────────────────

app.get('/api/movers', async (req, res) => {
  // 可調參數：?minValue=100000000（最低成交金額，預設 1 億）&excludeETF=1
  const minValue = +(req.query.minValue || 100_000_000);  // 1 億成交金額過濾
  const excludeETF = req.query.excludeETF !== '0';

  try {
    const data = await memo(`movers:${minValue}:${excludeETF}`, 30000, async () => {
      try {
        const rows = await twse.stockDayAll();
        const arr = rows
          .filter((r) => r.ClosingPrice && +r.TradeVolume > 0 && +r.TradeValue >= minValue)
          // 排除 ETF / 受益憑證（代號 4-5 字、開頭 00 = ETF）
          .filter((r) => !excludeETF || !/^00/.test(r.Code))
          // 排除權證（5-6 字）與全額交割股
          .filter((r) => /^\d{4}$/.test(r.Code))
          .map((r) => {
            const close = +r.ClosingPrice;
            const change = +r.Change || 0;          // 跟「昨收」的漲跌點數（TWSE 直接給）
            const prevClose = close - change;
            const pct = prevClose ? (change / prevClose) * 100 : 0;
            return {
              code: r.Code, name: r.Name, close,
              open: +r.OpeningPrice,
              high: +r.HighestPrice, low: +r.LowestPrice,
              volume: +r.TradeVolume,
              tradeValue: +r.TradeValue,
              prevClose, change, pct,
            };
          })
          .filter((s) => Number.isFinite(s.pct));

        // 排序前再做一次 sanity check：漲跌幅應在 ±10% 內（台股漲跌停限制）
        const sane = arr.filter((s) => s.pct >= -11 && s.pct <= 11);
        const gainers = [...sane].sort((a, b) => b.pct - a.pct).slice(0, 12);
        const losers  = [...sane].sort((a, b) => a.pct - b.pct).slice(0, 12);
        return {
          source: 'twse',
          algo: `跟昨收比 · 成交金額 ≥ ${(minValue / 1e8).toFixed(0)} 億${excludeETF ? ' · 排除 ETF' : ''}`,
          totalScanned: arr.length,
          gainers, losers,
        };
      } catch (e) {
        // 盤中 fallback：MI_INDEX20（漲幅前 20）
        const top = await twse.topGainers();
        const arr = top.map((r) => ({
          code: r.Code, name: r.Name,
          close: +r.ClosingPrice,
          open: +r.OpeningPrice,
          high: +r.HighestPrice, low: +r.LowestPrice,
          volume: +r.TradeVolume,
          pct: r.Dir === '-' ? -((+r.Change / (+r.ClosingPrice + +r.Change)) * 100) : ((+r.Change / (+r.ClosingPrice - +r.Change)) * 100),
        }));
        return { source: 'twse-top', algo: '盤中漲幅前 20（fallback）', gainers: arr.slice(0, 12), losers: [] };
      }
    });
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 共用診斷邏輯（單一事實來源） ─────────────────────────
// 同時給 /api/diagnose/:code 與 /api/ranking 使用，確保兩邊 winRate 一致
// 設計原則：每個資料源獨立 catch，任一失敗不影響其他；K 線兩段 fallback (FinMind → Yahoo)
async function loadStockDiagnose(code) {
  const start = new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);
  const today = todayIso();

  // 6 個資料源全部包 catch，避免一個壞掉拖死全部
  const safeCall = (label, fn) => fn().catch((e) => {
    console.warn(`[diag ${code}] ${label} failed:`, e.message);
    return null;
  });

  const [klineRaw, instRaw, shInfo, misArr, taiexCloses, newsList] = await Promise.all([
    safeCall('kline:finmind', () => memo(`kline:${code}:90`, 60000, () => finmind.stockPrice(code, start))),
    safeCall('inst', () => memo(`inst:${code}`, TTL_HIST / 24, () => finmind.institutional(code, start))),
    safeCall('shares', () => memo(`shares:${code}`, TTL_HIST, () => finmind.sharesOutstanding(code))),
    safeCall('mis', () => memo(`mis:${code}`, 1000, () => twseMis.quotes([code], 'tse'))),
    // TAIEX 收盤陣列（截面相對強度用）— 全機共用 1 天 cache
    safeCall('taiex:closes', () => memo('taiex:closes:90', 86400000, async () => {
      try {
        const data = await yahoo.chart('^TWII', '3mo', '1d');
        return (data || []).map((d) => +d.close).filter(Number.isFinite);
      } catch { return []; }
    })),
    // 個股相關新聞（情緒分析用）— 5 分鐘 cache
    safeCall('news', () => memo(`stockNews:${code}`, 5 * 60 * 1000, async () => {
      try {
        const list = await cnyes.newsSearch(code, 25);
        // 退到多分類聚合做關鍵字過濾（補充樣本）
        if (!list || list.length < 5) {
          const agg = await cnyes.newsAggregate(['tw_stock', 'headline'], 60);
          const codeRe = new RegExp(`(?<!\\d)${code}(?!\\d)`);
          const filtered = agg.filter((n) => {
            const t = `${n.title || ''} ${n.summary || ''}`;
            return codeRe.test(t);
          });
          return [...(list || []), ...filtered].slice(0, 25);
        }
        return list;
      } catch { return []; }
    })),
  ]);

  // K 線 4 層 fallback（順序已重排：TWSE 為主，因 FinMind 402 / Yahoo 429 都靠不住）
  // FinMind → TWSE STOCK_DAY → Stooq → Yahoo
  let kSource = 'finmind';
  let rawKline = klineRaw;
  if (!rawKline || rawKline.length < 30) {
    try {
      const tw = await memo(`twseDay:${code}:90`, 24 * 60 * 60 * 1000, () => twse.stockDayHistory(code, 90));
      if (tw && tw.length >= 30) {
        rawKline = tw.map((d) => ({
          open: d.open, high: d.high, low: d.low, close: d.close,
          Trading_Volume: d.volume,
          date: d.date,
        }));
        kSource = 'twse';
      }
    } catch (e) { console.warn(`[diag ${code}] twse:`, e.message); }
  }
  if (!rawKline || rawKline.length < 30) {
    try {
      const sq = await memo(`sqKline:${code}:90`, 30 * 60 * 1000, () => stooq.chart(`${code}.tw`, 100));
      if (sq && sq.length >= 30) {
        rawKline = sq.map((d) => ({
          open: d.open, high: d.high, low: d.low, close: d.close,
          Trading_Volume: Math.round((d.volume || 0) / 1000),
          date: d.date,
        }));
        kSource = 'stooq';
      }
    } catch (e) { console.warn(`[diag ${code}] stooq:`, e.message); }
  }
  if (!rawKline || rawKline.length < 30) {
    try {
      const yhK = await memo(`yhKline:${code}:90`, 300000, () => yahoo.chart(`${code}.TW`, '3mo', '1d'));
      if (yhK && yhK.length >= 30) {
        rawKline = yhK.map((d) => ({
          open: d.open, high: d.high, low: d.low, close: d.close,
          Trading_Volume: Math.round((d.volume || 0) / 1000),
          date: d.date,
        }));
        kSource = 'yahoo';
      }
    } catch (e) { console.warn(`[diag ${code}] yahoo:`, e.message); }
  }

  if (!rawKline || rawKline.length < 20) {
    throw new Error(`K 線資料不足（FinMind/Yahoo/TWSE/Stooq 全失敗）`);
  }

  // 法人 fallback：FinMind 失敗 → 改打 TWSE T86（免 quota）
  let instUsed = instRaw && instRaw.length ? instRaw : null;
  if (!instUsed) {
    try {
      const tw = await memo(`twseInst:${code}:5`, 60 * 60 * 1000, () => twse.institutionalRecentForCode(code, 5));
      if (tw && tw.length) instUsed = tw;
    } catch (e) { console.warn(`[diag ${code}] twse T86:`, e.message); }
  }

  const k = rawKline.map((r) => ({
    open: +r.open,
    high: +(r.max ?? r.high),
    low: +(r.min ?? r.low),
    close: +r.close,
    vol: +(r.Trading_Volume ?? r.volume ?? 0),
    date: r.date,
  })).filter((d) => Number.isFinite(d.close));

  if (k.length < 20) throw new Error(`K 線有效筆數不足（${k.length} 筆）`);

  // ── 即時資料覆蓋（與前端邏輯保持一致：close/high/low/vol 全覆蓋；缺今日則補 bar）──
  const mis = misArr?.[0];
  if (mis?.price != null) {
    const last = k[k.length - 1];
    if (last.date === today) {
      last.close = mis.price;
      if (mis.high && mis.high > last.high) last.high = mis.high;
      if (mis.low && mis.low < last.low) last.low = mis.low;
      if (Number.isFinite(mis.volume) && mis.volume > (last.vol || 0)) last.vol = mis.volume;
    } else {
      k.push({
        date: today,
        open: mis.open ?? mis.price,
        high: mis.high ?? mis.price,
        low: mis.low ?? mis.price,
        close: mis.price,
        vol: Number.isFinite(mis.volume) ? mis.volume : 0,
      });
    }
  }

  // ── 法人資料 enrich：補 trustPctOfCap（與 /api/institutional/:code 同邏輯）──
  const cap = shInfo?.sharesOutstanding ? +shInfo.sharesOutstanding : null;
  const instEnriched = (instUsed || []).map((r) => {
    if (!cap || !r.name?.includes('投信')) return r;
    const net = (+r.buy || 0) - (+r.sell || 0);
    return { ...r, trustPctOfCap: (net / cap) * 100 };
  });

  // 計算新聞情緒（純函式，無網路）
  const sentiment = newsSentiment(newsList || []);

  // ★ Feature engineering：注入大盤 regime / RS / 波動度 + 產業 RS + 基本面
  const [marketContext, industryStats, fundamentalsData] = await Promise.all([
    getMarketContext().catch(() => null),
    getIndustryStatsFor(code).catch(() => null),
    memo(`fund:${code}`, TTL_HIST / 24, async () => {
      // 重用 fundamentals endpoint 的核心邏輯（簡化版：只取我們要用的幾個欄位）
      try {
        const all = await memo('bwibbu:all', TTL_HIST / 24, () => twse.bwibbu());
        const r = all.find((x) => x.Code === code);
        return r ? {
          pe: +r.PEratio || null,
          pb: +r.PBratio || null,
          divYield: +r.DividendYield || null,
        } : null;
      } catch { return null; }
    }).catch(() => null),
  ]);

  const d = diagnose(k, instEnriched, {
    sharesOutstanding: cap,
    benchmarkCloses: taiexCloses || [],
    newsSentiment: sentiment,
    marketContext,
    industryStats,
    fundamentals: fundamentalsData,
  });
  if (!d) return null;

  const close = k[k.length - 1].close;
  const atr = d.atr14 || close * 0.025;

  // ─── 自我學習回饋迴路 ───
  // 1. 用當前 K 線驗證過去未驗證的預測（標記 hit/miss + 誤差）
  predictions.validate(code, k);

  // 2. 取個股近期準確度信心倍率，套到 winRate（縮放偏離 50 的幅度）
  const cm = predictions.getConfidenceMultiplier(code);
  const baseWinRate = d.winRate;
  if (cm.multiplier !== 1.0) {
    d.winRate = Math.round(50 + (baseWinRate - 50) * cm.multiplier);
    // direction 也要跟著調整（避免 winRate 被拉到 50 附近還說 long）
    d.direction = d.winRate >= 55 ? 'long' : d.winRate >= 45 ? 'neutral' : 'short';
  }
  d.personalAccuracy = {
    multiplier: cm.multiplier,
    reason: cm.reason,
    baseWinRate,
    samples: cm.stats.samples,
    recentHitRate: cm.stats.recentHitRate,
    mae: cm.stats.mae,
    consecutiveBigError: cm.stats.consecutiveBigError,
    last: cm.stats.last,
    pending: cm.stats.pending,
  };

  // 3. 記錄本次預測（給未來驗證用）+ 順手存 feature vector 為將來 ML pipeline 鋪路
  predictions.record(code, {
    close,
    winRate: d.winRate,
    direction: d.direction,
    target1: d.levels?.target1,
    stop: d.levels?.stop,
    expectedReturn: d.economic?.expectedReturn,
    features: d.features || null,   // ★ ML-ready feature vector
  });

  return {
    ...d,
    code,
    close,
    prevClose: mis?.prevClose ?? k[k.length - 2]?.close,
    chg: mis?.chg,
    pct: mis?.pct,
    entry: { low: +(close - atr * 0.5).toFixed(2), high: +(close + atr * 0.5).toFixed(2) },
    stopATR: +(close - 2 * atr).toFixed(0),
    targetATR: +(close + 3 * atr).toFixed(0),
    costPerLot: Math.round(close * 1000),
  };
}

// ───────────────────────── 個人持股追蹤 + 每日報告 ─────────────────────────
// 台股交易成本：手續費 0.1425%（買賣都收）、證交稅 0.3%（賣出收）
const FEE_RATE = 0.001425;
const TAX_RATE = 0.003;
const FEE_MIN = 20;  // 最低手續費 20 元

// 計算實際損益（含手續費與證交稅）
//   買進總成本 = price × shares × (1 + 手續費率)，但最低 20 元手續費
//   賣出實得  = price × shares × (1 - 手續費率 - 證交稅率)
//   損益       = 賣出實得 - 買進成本
function computePL(entryPrice, currentPrice, lots) {
  const shares = lots * 1000;
  const buyGross = entryPrice * shares;
  const buyFee = Math.max(buyGross * FEE_RATE, FEE_MIN);
  const buyTotal = buyGross + buyFee;
  const sellGross = currentPrice * shares;
  const sellFee = Math.max(sellGross * FEE_RATE, FEE_MIN);
  const sellTax = sellGross * TAX_RATE;
  const sellNet = sellGross - sellFee - sellTax;
  const pl = sellNet - buyTotal;
  const plPct = (pl / buyTotal) * 100;
  const avgEntry = buyTotal / shares;     // 含手續費的「實際成交均價」
  const breakEven = (buyTotal) / (shares * (1 - FEE_RATE - TAX_RATE)); // 損益兩平價
  return {
    pl: +pl.toFixed(0),
    plPct: +plPct.toFixed(2),
    buyTotal: +buyTotal.toFixed(0),
    sellNet: +sellNet.toFixed(0),
    avgEntry: +avgEntry.toFixed(2),
    breakEven: +breakEven.toFixed(2),
    fees: +(buyFee + sellFee + sellTax).toFixed(0),
  };
}

// 列出所有持股（active / closed 都拿）— 並自動帶上「現在該怎麼辦」的診斷
app.get('/api/portfolio', async (req, res) => {
  try {
    const status = req.query.status || null;
    const holdings = await portfolio.list({ status });
    // 給 active 持股自動套上即時診斷（背景並行）
    const enriched = await Promise.all(holdings.map(async (h) => {
      if (h.status !== 'active') return h;
      try {
        const d = await memo(`diag:${h.code}`, 30000, () => loadStockDiagnose(h.code));
        if (!d) return h;
        const currentPrice = d.close;
        const plData = computePL(h.entry_price, currentPrice, h.lots);
        let advice;
        if (d.personalAccuracy?.consecutiveBigError) advice = 'reduce';
        else if (d.winRate >= 60 && plData.plPct > 0) advice = 'hold';
        else if (d.winRate >= 60) advice = 'add';
        else if (d.winRate < 40 || (d.levels?.stop && currentPrice < d.levels.stop)) advice = 'sell';
        else if (d.levels?.target1 && currentPrice >= d.levels.target1) advice = 'take_profit';
        else advice = 'hold';
        return {
          ...h,
          current_price: currentPrice,
          pl: plData.pl,
          pl_pct: plData.plPct,
          avg_entry: plData.avgEntry,
          break_even: plData.breakEven,
          fees: plData.fees,
          buy_total: plData.buyTotal,
          win_rate: d.winRate,
          direction: d.direction,
          advice,
          stop: d.levels?.stop,
          target1: d.levels?.target1,
          name: d.name,
        };
      } catch {
        return h;
      }
    }));
    ok(res, enriched);
  } catch (e) { fail(res, e); }
});
// 新增持股
app.post('/api/portfolio', async (req, res) => {
  try {
    const data = await portfolio.add(req.body);
    ok(res, data);
  } catch (e) { fail(res, e, 400); }
});
// 平倉（出場）
app.post('/api/portfolio/:id/close', async (req, res) => {
  try {
    const data = await portfolio.close(+req.params.id, req.body);
    ok(res, data);
  } catch (e) { fail(res, e, 400); }
});
// 編輯
app.patch('/api/portfolio/:id', async (req, res) => {
  try {
    const data = await portfolio.update(+req.params.id, req.body);
    ok(res, data);
  } catch (e) { fail(res, e, 400); }
});
// 刪除
app.delete('/api/portfolio/:id', async (req, res) => {
  try {
    const data = await portfolio.remove(+req.params.id);
    ok(res, data);
  } catch (e) { fail(res, e, 400); }
});

// ───────────────────────── 每日報告 / 每週復盤 ─────────────────────────
// 每日報告：盤點所有 active 持股 + 個別建議
app.get('/api/reports/daily', async (_req, res) => {
  try {
    const holdings = await portfolio.list({ status: 'active' });
    if (!holdings.length) {
      return ok(res, { date: todayIso(), holdings: 0, message: '目前無持股，請先到「我的持股」面板輸入', items: [] });
    }
    const items = await Promise.all(holdings.map(async (h) => {
      const d = await memo(`diag:${h.code}`, 30000, () => loadStockDiagnose(h.code)).catch(() => null);
      if (!d) return { code: h.code, error: '診斷失敗' };
      const cur = d.close;
      const pl = computePL(h.entry_price, cur, h.lots);
      const days = Math.floor((Date.now() - new Date(h.entry_date).getTime()) / 86400000);
      const lines = [];
      lines.push(`【${h.code}${d.name ? ' ' + d.name : ''}】持有 ${days} 天，目前 ${cur.toFixed(2)}（買進 ${h.entry_price}，含費均價 ${pl.avgEntry}）`);
      lines.push(`  實際損益：${pl.plPct >= 0 ? '+' : ''}${pl.plPct.toFixed(2)}%（${pl.pl >= 0 ? '獲利' : '虧損'} ${Math.abs(pl.pl).toLocaleString()} 元，已扣手續費+證交稅 ${pl.fees.toLocaleString()} 元）`);
      lines.push(`  損益兩平價：${pl.breakEven}　·　系統勝率 ${d.winRate}%（${d.direction === 'long' ? '偏多' : d.direction === 'short' ? '偏空' : '中性'}）`);
      if (d.levels?.stop && cur < d.levels.stop) {
        lines.push(`  ⚠️ 已跌破停損 ${d.levels.stop} — 建議出場`);
      } else if (d.levels?.target1 && cur >= d.levels.target1) {
        lines.push(`  🎯 已達第一停利 ${d.levels.target1} — 建議停利一半`);
      } else if (d.personalAccuracy?.consecutiveBigError) {
        lines.push(`  ⚠️ 此股近期模型不準（連 3 筆誤差 > 5%）— 建議降低部位`);
      } else if (d.winRate < 40) {
        lines.push(`  ⚠️ 訊號偏空 — 反彈即減碼`);
      } else if (d.winRate >= 60 && pl.plPct < 0) {
        lines.push(`  💡 訊號仍偏多但目前虧損 — 可考慮在 ${d.levels?.support20 || ''} 加碼攤平`);
      } else if (d.winRate >= 60) {
        lines.push(`  ✓ 訊號維持偏多 — 持有，目標 ${d.levels?.target1}、停損 ${d.levels?.stop}`);
      } else {
        lines.push(`  ⚪ 訊號中性 — 觀察 ${d.levels?.high60} / ${d.levels?.low60} 突破方向`);
      }
      return {
        code: h.code,
        name: d.name,
        entryDate: h.entry_date,
        entryPrice: h.entry_price,
        avgEntry: pl.avgEntry,
        breakEven: pl.breakEven,
        fees: pl.fees,
        lots: h.lots,
        currentPrice: cur,
        plPct: pl.plPct,
        plAmount: pl.pl,
        days,
        winRate: d.winRate,
        direction: d.direction,
        stop: d.levels?.stop,
        target1: d.levels?.target1,
        text: lines.join('\n'),
      };
    }));
    // 整體統計
    const validItems = items.filter((i) => !i.error);
    const totalPL = validItems.reduce((s, i) => s + (i.plAmount || 0), 0);
    const winners = validItems.filter((i) => i.plPct > 0).length;
    const losers = validItems.filter((i) => i.plPct < 0).length;
    ok(res, {
      date: todayIso(),
      holdings: holdings.length,
      summary: {
        totalPL,
        winners,
        losers,
        winRate: validItems.length ? +(winners / validItems.length * 100).toFixed(1) : 0,
      },
      items,
    });
  } catch (e) { fail(res, e); }
});

// 每週復盤：彙整本週所有持股的表現變化
app.get('/api/reports/weekly', async (_req, res) => {
  try {
    const all = await portfolio.list();
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 86400000);
    const weekAgoIso = weekAgo.toISOString().slice(0, 10);
    // 本週新進場的持股
    const newThisWeek = all.filter((h) => h.entry_date >= weekAgoIso);
    // 本週平倉的持股
    const closedThisWeek = all.filter((h) => h.status === 'closed' && h.exit_date >= weekAgoIso);
    // 最佳/最差表現（active 持股）
    const active = all.filter((h) => h.status === 'active');
    const enriched = await Promise.all(active.map(async (h) => {
      const d = await memo(`diag:${h.code}`, 30000, () => loadStockDiagnose(h.code)).catch(() => null);
      if (!d) return null;
      const plPct = ((d.close - h.entry_price) / h.entry_price) * 100;
      return { code: h.code, name: d.name, plPct, lots: h.lots, entryDate: h.entry_date };
    }));
    const validActive = enriched.filter(Boolean);
    validActive.sort((a, b) => b.plPct - a.plPct);
    const best = validActive.slice(0, 3);
    const worst = validActive.slice(-3).reverse();

    // 已平倉的本週實現獲利
    const realizedPL = closedThisWeek.reduce((s, h) => {
      if (h.exit_price && h.entry_price) {
        return s + ((h.exit_price - h.entry_price) * h.lots * 1000);
      }
      return s;
    }, 0);
    const closedWinners = closedThisWeek.filter((h) => h.exit_price && h.exit_price > h.entry_price).length;

    // 大盤本週表現（已 cache 1 天的 TAIEX kline）
    let taiexWeekPct = null;
    try {
      const closes = await memo('taiex:closes:90', 86400000, async () => {
        try {
          const data = await yahoo.chart('^TWII', '3mo', '1d');
          return (data || []).map((d) => +d.close).filter(Number.isFinite);
        } catch { return []; }
      });
      if (closes.length >= 7) {
        const now = closes[closes.length - 1];
        const wago = closes[closes.length - 6]; // ~5 trading days
        if (wago) taiexWeekPct = +(((now - wago) / wago) * 100).toFixed(2);
      }
    } catch { /* ignore */ }

    ok(res, {
      weekStart: weekAgoIso,
      weekEnd: todayIso(),
      newPositions: newThisWeek.length,
      closedPositions: closedThisWeek.length,
      activePositions: active.length,
      realizedPL,
      closedWinners,
      taiexWeekPct,
      best,
      worst,
      newThisWeek,
      closedThisWeek,
    });
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 預測追蹤（自我學習回饋資料） ─────────────────────────
// Supabase 連線狀態 + memory cache 摘要
app.get('/api/predictions/status', (_req, res) => {
  ok(res, predictions.status());
});
// Supabase 完整 round-trip 自檢（寫→讀→刪）
app.get('/api/predictions/healthcheck', async (_req, res) => {
  const result = await predictions.healthcheck();
  if (result.ok) ok(res, result);
  else res.status(503).json({ ok: false, ...result });
});
// 查看單檔歷史預測 + 命中率統計
app.get('/api/predictions/:code', (req, res) => {
  try {
    const code = req.params.code;
    const all = predictions.getAll()[code] || [];
    const stats = predictions.getStats(code);
    ok(res, { code, stats, history: all.slice(-30) });
  } catch (e) { fail(res, e); }
});
app.get('/api/predictions', (_req, res) => {
  // 各檔摘要
  const all = predictions.getAll();
  const summary = Object.entries(all).map(([code, arr]) => ({
    code,
    total: arr.length,
    validated: arr.filter((p) => p.validated).length,
    pending: arr.filter((p) => !p.validated).length,
    recentHitRate: predictions.getStats(code)?.recentHitRate ?? null,
  })).sort((a, b) => b.total - a.total);
  ok(res, summary);
});

// ───────────────────────── 個股診斷（單檔） ─────────────────────────
app.get('/api/diagnose/:code', async (req, res) => {
  const code = req.params.code;
  try {
    const data = await memo(`diag:${code}`, 30000, () => loadStockDiagnose(code));
    if (!data) return fail(res, new Error('資料不足無法診斷'));
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 短線勝率排行榜 ─────────────────────────
// 對給定 codes 並行跑 diagnose，按 winRate 排序。
// 為了保 FinMind quota，整體結果 cache 5 分鐘。
app.get('/api/ranking', async (req, res) => {
  const codes = (req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean);
  const limit = +(req.query.limit || 10);
  const minWinRate = +(req.query.minWinRate || 0);
  const maxBudget = +(req.query.maxBudget || 0); // 單張預算上限（>0 才篩選）
  if (!codes.length) return ok(res, []);

  try {
    const cacheKey = `ranking:${codes.join(',')}`;
    const data = await memo(cacheKey, 5 * 60 * 1000, async () => {
      // 用共用 helper：每檔結果 cache 30 秒（避免 FinMind 暴打）
      const tasks = codes.map(async (code) => {
        try {
          const r = await memo(`diag:${code}`, 30000, () => loadStockDiagnose(code));
          if (!r) return null;
          // 對齊舊欄位，給前端 portfolio 表格用
          return {
            code: r.code,
            close: r.close,
            prevClose: r.prevClose,
            chg: r.chg,
            pct: r.pct,
            winRate: r.winRate,
            score: r.score,
            subScores: r.subScores,
            overall: r.overall,
            action: r.action,
            trend: r.trend,
            kdSignal: r.kd?.signal,
            macdSignal: r.macd?.signal,
            volSignal: r.vol?.signal,
            mainForce: r.inst?.mainForce,
            bias20: r.bias20,
            atr14: r.atr14,
            entry: r.entry,
            stop: r.stopATR,
            target: r.targetATR,
            signals: r.signals?.slice(0, 2),
            costPerLot: r.costPerLot,
          };
        } catch { return null; }
      });
      const results = (await Promise.all(tasks)).filter(Boolean);
      results.sort((a, b) => b.winRate - a.winRate);
      return results;
    });

    // 篩選（不算進 cache，因 cache key 不含 minWinRate / maxBudget）
    let filtered = data;
    if (minWinRate > 0) filtered = filtered.filter((r) => r.winRate >= minWinRate);
    if (maxBudget > 0) filtered = filtered.filter((r) => r.costPerLot <= maxBudget);

    ok(res, filtered.slice(0, limit));
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 即時新聞（鉅亨網 + Yahoo 多源）─────────────────────────
// 一般用法：?category=tw_stock&limit=20  → 單一分類
// 個股精準搜尋：?keyword=2330+台積電&limit=30 → 鉅亨網全文搜尋 + Yahoo 新聞 + 多分類聚合
app.get('/api/news', async (req, res) => {
  const category = req.query.category || 'tw_stock';
  const limit = +(req.query.limit || 20);
  const keyword = (req.query.keyword || '').trim();

  try {
    if (keyword) {
      // 個股關鍵字 — 多源聚合 + 嚴格過濾（cache 90 秒）
      const cacheKey = `newsSearch:${keyword}:${limit}`;
      const data = await memo(cacheKey, 90000, async () => {
        const [search, agg, yh] = await Promise.allSettled([
          cnyes.newsSearch(keyword, 30),
          cnyes.newsAggregate(['tw_stock', 'headline', 'wd_stock'], 60),
          yahoo.news(keyword, 20),
        ]);

        // 從 keyword 拆出「代號」與「股名」，只接受其一明確命中的新聞
        const tokens = keyword.split(/\s+/).filter(Boolean);
        const codeToken = tokens.find((t) => /^\d{4,6}$/.test(t));
        const nameTokens = tokens.filter((t) => !/^\d/.test(t) && t.length >= 2);
        // 代號需前後不接其他數字（避免 23300 命中 2330）
        const codeRe = codeToken ? new RegExp(`(?<!\\d)${codeToken}(?!\\d)`) : null;

        const matchesStock = (n) => {
          const text = `${n.title || ''} ${n.summary || ''}`;
          if (!text.trim()) return false;
          if (codeRe && codeRe.test(text)) return true;
          if (nameTokens.some((nm) => text.includes(nm))) return true;
          return false;
        };

        const all = [];
        const seen = new Set();
        const push = (n) => {
          if (!n.title || !matchesStock(n)) return;
          const key = (n.id ? `id:${n.id}` : '') + '|' + n.title.slice(0, 30);
          if (seen.has(key)) return;
          seen.add(key);
          all.push(n);
        };
        if (search.status === 'fulfilled') search.value.forEach(push);
        if (yh.status === 'fulfilled') yh.value.forEach(push);
        if (agg.status === 'fulfilled') agg.value.forEach(push);
        all.sort((a, b) => (b.publishAt || 0) - (a.publishAt || 0));
        return all.slice(0, limit);
      });
      return ok(res, data);
    }

    // 不帶 keyword → 維持原行為（單一分類）
    const data = await memo(`news:${category}:${limit}`, 60000, () => cnyes.newsList(category, limit));
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 啟動 ─────────────────────────

app.listen(PORT, async () => {
  console.log(`▌ 台股戰情室 backend 啟動 → http://localhost:${PORT}`);
  console.log(`  session=${getSession()}  finmind_token=${process.env.FINMIND_TOKEN ? 'set' : 'missing'}`);
  console.log(`  supabase=${process.env.SUPABASE_URL ? 'set' : 'missing'}`);

  // 載入預測歷史（從 Supabase 拉到 in-memory；async，但用戶 API 不會等）
  predictions.load().then((n) => {
    console.log(`  predictions loaded from Supabase: ${n} 檔`);
  }).catch((e) => console.warn('  predictions load failed:', e.message));

  // 每 5 分鐘強制 flush 一次（保險用，dirty queue 平常 2 秒 debounce 會自己寫）
  setInterval(async () => {
    const n = await predictions.persist();
    if (n > 0) console.log(`  predictions flushed: ${n} rows`);
  }, 5 * 60 * 1000);

  // graceful shutdown：強制把 dirty queue 寫完再退出
  ['SIGTERM', 'SIGINT'].forEach((sig) => {
    process.on(sig, async () => {
      console.log(`▌ shutdown signal: ${sig}, flushing predictions...`);
      try {
        const n = await predictions.persist();
        console.log(`▌ predictions flushed: ${n} rows`);
      } catch (e) {
        console.warn('▌ flush on shutdown failed:', e.message);
      }
      process.exit(0);
    });
  });

  // 啟動預熱（預設關閉，避免 FinMind/Yahoo 在啟動 30 秒內被打爆 quota）
  // 要開：環境變數 WARM_CACHE=1
  if (process.env.WARM_CACHE === '1') {
    setTimeout(async () => {
      const t0 = Date.now();
      const WEIGHTED = ['2330', '2317', '2454', '2308', '2891', '2882'];
      try {
        await Promise.allSettled([
          // 大盤指數（前端 boot 必呼叫）
          memo('indices', 1500, async () => {
            try {
              const tw = await twseMis.indices();
              return {
                session: getSession(),
                taiex: tw.taiex && { close: tw.taiex.price, change: tw.taiex.chg, pct: tw.taiex.pct, source: 'twse-mis' },
                otc: tw.otc && { close: tw.otc.price, change: tw.otc.chg, pct: tw.otc.pct, source: 'twse-mis' },
              };
            } catch { return null; }
          }).catch(() => null),
          // 權值股 diagnose 預熱
          ...WEIGHTED.map((c) => memo(`diag:${c}`, 30000, () => loadStockDiagnose(c)).catch(() => null)),
        ]);
        console.log(`  warm cache ✓ ${WEIGHTED.length + 1} items in ${Date.now() - t0}ms`);
      } catch (e) {
        console.warn('  warm cache failed:', e.message);
      }
    }, 3000);
  }
});
