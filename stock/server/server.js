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
import * as cnyes from './providers/cnyes.js';

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
    yahoo: {},
    finmind: {},
    twse: {},
  };

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
    const data = await memo('indices', TTL_LIVE, async () => {
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

      // 國際指數（Yahoo cache 60 秒，避免和個股 quotes 競爭 429 quota）
      const intl = await memo('intl', 60000, () => yahoo.quotes(['^SOX', '^IXIC', '^GSPC', '^DJI']));
      const norm = (q) => {
        if (!q || q.price == null || q.prevClose == null) return null;
        return {
          close: q.price,
          change: q.price - q.prevClose,
          pct: q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : 0,
          symbol: q.symbol,
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
    const data = await memo(`kline:${code}:${days}`, TTL_LIVE * 60, () => finmind.stockPrice(code, start, end));
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 個股即時報價批次 ─────────────────────────
// 主源：TWSE MIS（台灣本地、券商級、無 rate limit、含五檔）
// 備援 1：Yahoo Finance（國際指數同源）
// 備援 2：FinMind 日線快取（盤中不發新請求、保 quota）
app.get('/api/quotes/batch', async (req, res) => {
  const codes = (req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!codes.length) return ok(res, {});
  try {
    const session = getSession();
    const out = {};
    const errors = {};

    // ─ 主源：TWSE MIS（cache 3 秒，比 Yahoo TTL 5 秒短，因為 MIS 即時度更高）─
    try {
      const misResults = await memo(`mis:${codes.join(',')}`, 3000, () => twseMis.quotes(codes, 'tse'));
      misResults.forEach((r) => {
        if (!r || r.error || r.price == null) {
          if (r?.error) errors[r.code] = r.error;
          return;
        }
        out[r.code] = {
          price: r.price,
          prev: r.prevClose,
          chg: r.chg,
          pct: r.pct,
          open: r.open,
          dayHigh: r.high,
          dayLow: r.low,
          volume: r.volume,
          bestBid: r.bestBid,
          bestAsk: r.bestAsk,
          bid: r.bid,
          ask: r.ask,
          bidVol: r.bidVol,
          askVol: r.askVol,
          limitUp: r.limitUp,
          limitDown: r.limitDown,
          time: r.time,
          source: 'twse-mis',
        };
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
          out[code] = {
            price: close,
            prev,
            chg: close - prev,
            pct: prev ? ((close - prev) / prev) * 100 : 0,
            dayHigh: q.dayHigh,
            dayLow: q.dayLow,
            volume: q.volume,
            time: q.time,
            source: 'yahoo',
          };
        });
      } catch (e) { errors._yahoo = e.message; }
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

app.get('/api/institutional/:code', async (req, res) => {
  const code = req.params.code;
  const start = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
  try {
    const data = await memo(`inst:${code}`, TTL_HIST / 24, () => finmind.institutional(code, start));
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

app.get('/api/movers', async (_req, res) => {
  try {
    const data = await memo('movers', TTL_LIVE, async () => {
      // 盤後優先 TWSE STOCK_DAY_ALL；盤中走 TWSE MI_INDEX20（漲幅前 20）
      try {
        const rows = await twse.stockDayAll();
        const arr = rows
          .filter((r) => r.ClosingPrice && r.OpeningPrice && +r.TradeVolume > 0)
          .map((r) => {
            const close = +r.ClosingPrice;
            const open = +r.OpeningPrice;
            const pct = ((close - open) / open) * 100;
            return {
              code: r.Code, name: r.Name, close, open,
              high: +r.HighestPrice, low: +r.LowestPrice,
              volume: +r.TradeVolume, pct,
            };
          })
          .filter((s) => Number.isFinite(s.pct));
        const gainers = [...arr].sort((a, b) => b.pct - a.pct).slice(0, 12);
        const losers = [...arr].sort((a, b) => a.pct - b.pct).slice(0, 12);
        return { source: 'twse', gainers, losers };
      } catch (e) {
        const top = await twse.topGainers();
        const arr = top.map((r) => ({
          code: r.Code, name: r.Name,
          close: +r.ClosingPrice,
          open: +r.OpeningPrice,
          high: +r.HighestPrice, low: +r.LowestPrice,
          volume: +r.TradeVolume,
          pct: r.Dir === '-' ? -((+r.Change / (+r.ClosingPrice + +r.Change)) * 100) : ((+r.Change / (+r.ClosingPrice - +r.Change)) * 100),
        }));
        return { source: 'twse-top', gainers: arr.slice(0, 12), losers: [] };
      }
    });
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 即時新聞（鉅亨網）─────────────────────────

app.get('/api/news', async (req, res) => {
  const category = req.query.category || 'tw_stock';
  const limit = +(req.query.limit || 20);
  try {
    const data = await memo(`news:${category}:${limit}`, 60000, () => cnyes.newsList(category, limit));
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 啟動 ─────────────────────────

app.listen(PORT, () => {
  console.log(`▌ 台股戰情室 backend 啟動 → http://localhost:${PORT}`);
  console.log(`  session=${getSession()}  finmind_token=${process.env.FINMIND_TOKEN ? 'set' : 'missing'}`);
});
