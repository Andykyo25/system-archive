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

    // ─ 主源：TWSE MIS（cache 1 秒，盡量即時。MIS 無 rate limit）─
    try {
      const misResults = await memo(`mis:${codes.join(',')}`, 1000, () => twseMis.quotes(codes, 'tse'));
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
// 回傳每筆 row 加上 trustPctOfCap = (該日投信淨買股數 / 流通股數) × 100

app.get('/api/institutional/:code', async (req, res) => {
  const code = req.params.code;
  const start = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
  try {
    const [rawInst, sh] = await Promise.all([
      memo(`inst:${code}`, TTL_HIST / 24, () => finmind.institutional(code, start)),
      memo(`shares:${code}`, TTL_HIST, () => finmind.sharesOutstanding(code).catch(() => null)),
    ]);
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
      const start = new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);

      // 1. 取得即時報價（MIS 一次拿，含當前 close）
      const misMap = {};
      try {
        const misResults = await memo(`mis:${codes.join(',')}`, 1000, () => twseMis.quotes(codes, 'tse'));
        misResults.forEach((r) => { if (r?.code && r.price != null) misMap[r.code] = r; });
      } catch { /* MIS 失敗也繼續 */ }

      // 2. 並行抓 K 線 + 三大法人 + 流通股數，跑 diagnose
      const tasks = codes.map(async (code) => {
        try {
          const [klineRaw, instRaw, shInfo] = await Promise.all([
            memo(`kline:${code}:90`, 60000, () => finmind.stockPrice(code, start)),
            memo(`inst:${code}`, TTL_HIST / 24, () => finmind.institutional(code, start)).catch(() => []),
            memo(`shares:${code}`, TTL_HIST, () => finmind.sharesOutstanding(code).catch(() => null)),
          ]);
          if (!klineRaw || klineRaw.length < 30) return null;
          const k = klineRaw.map((r) => ({
            open: +r.open,
            high: +(r.max ?? r.high),
            low: +(r.min ?? r.low),
            close: +r.close,
            vol: +(r.Trading_Volume ?? r.volume ?? 0),
            date: r.date,
          })).filter((d) => Number.isFinite(d.close));
          if (k.length < 30) return null;

          // 用 MIS 即時價覆蓋最後一筆 close
          const mis = misMap[code];
          if (mis?.price != null) {
            const last = k[k.length - 1];
            last.close = mis.price;
            if (mis.high && mis.high > last.high) last.high = mis.high;
            if (mis.low && mis.low < last.low) last.low = mis.low;
          }

          const sharesOutstanding = shInfo?.sharesOutstanding || null;
          const d = diagnose(k, instRaw, { sharesOutstanding });
          if (!d) return null;

          const close = k[k.length - 1].close;
          const atr = d.atr14 || close * 0.025;
          return {
            code,
            close,
            prevClose: mis?.prevClose ?? k[k.length - 2]?.close,
            chg: mis?.chg,
            pct: mis?.pct,
            winRate: d.winRate,
            score: d.score,
            subScores: d.subScores,
            overall: d.overall,
            action: d.action,
            trend: d.trend,
            kdSignal: d.kd.signal,
            macdSignal: d.macd.signal,
            volSignal: d.vol.signal,
            mainForce: d.inst.mainForce,
            bias20: d.bias20,
            atr14: d.atr14,
            entry: { low: +(close - atr * 0.5).toFixed(2), high: +(close + atr * 0.5).toFixed(2) },
            stop: +(close - 2 * atr).toFixed(0),
            target: +(close + 3 * atr).toFixed(0),
            signals: d.signals?.slice(0, 2),
            costPerLot: Math.round(close * 1000), // 一張成本 = close × 1000 股
          };
        } catch (e) {
          return null;
        }
      });

      const results = (await Promise.all(tasks)).filter(Boolean);
      // 排序：winRate 降冪
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
      // 個股關鍵字 — 多源聚合（cache 90 秒）
      const cacheKey = `newsSearch:${keyword}:${limit}`;
      const data = await memo(cacheKey, 90000, async () => {
        const [search, agg, yh] = await Promise.allSettled([
          cnyes.newsSearch(keyword, 30),
          cnyes.newsAggregate(['tw_stock', 'headline', 'wd_stock'], 60),
          yahoo.news(keyword, 20),
        ]);
        const all = [];
        const seen = new Set();
        const push = (n) => {
          if (!n.title) return;
          const key = (n.id ? `id:${n.id}` : '') + '|' + n.title.slice(0, 30);
          if (seen.has(key)) return;
          seen.add(key);
          all.push(n);
        };
        if (search.status === 'fulfilled') search.value.forEach(push);
        if (yh.status === 'fulfilled') yh.value.forEach(push);
        // 聚合分類僅作 keyword 過濾後加入（避免無關新聞淹沒）
        if (agg.status === 'fulfilled') {
          const kws = keyword.split(/\s+/).filter(Boolean);
          agg.value.forEach((n) => {
            const text = `${n.title} ${n.summary || ''}`;
            if (kws.some((k) => text.includes(k))) push(n);
          });
        }
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

// ───────────────────────── 個股盤中分時資料 ─────────────────────────
// Yahoo intraday：1 分線、當日 → 給「即時走勢圖」用
app.get('/api/intraday/:code', async (req, res) => {
  const code = req.params.code;
  const interval = req.query.interval || '1m';
  try {
    const data = await memo(`intraday:${code}:${interval}`, 30000, () => yahoo.intraday(`${code}.TW`, { interval, range: '1d' }));
    ok(res, data);
  } catch (e) { fail(res, e); }
});

// ───────────────────────── 啟動 ─────────────────────────

app.listen(PORT, () => {
  console.log(`▌ 台股戰情室 backend 啟動 → http://localhost:${PORT}`);
  console.log(`  session=${getSession()}  finmind_token=${process.env.FINMIND_TOKEN ? 'set' : 'missing'}`);
});
