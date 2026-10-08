// 背景工作(jobs)的純函式:資料轉換與任務清單。不碰 SDK / 網路 / DB,方便單元測試(jobs-lib.test.mjs)。
// 欄位名依富邦行情官方文件(tdcc-distribution / etf-holdings / institutional-trades / historical candles);
// 回傳形狀不符就丟錯,讓該任務標為失敗,而不是靜默寫入錯誤資料。

import { addDaysIso, toIsoDate } from './lib.mjs';

export const SYMBOL_OK = /^[0-9A-Za-z]{4,6}$/;
// ETF 成分股:只收台股代號(至少一個數字、無空白);海外成分如 'AAPL UQ' 會被排除。
export const TW_COMPONENT_OK = /^(?=.*[0-9])[0-9A-Z]{4,6}$/;
// 股票型主動式 ETF(…D 結尾是債券型,成分不是股票)
export const ACTIVE_STOCK_ETF_OK = /^[0-9]{5}A$/;

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const finite = (v, what) => {
  const n = num(v);
  if (n === null || !Number.isFinite(n)) throw new Error(`bad ${what}`);
  return n;
};
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
// null 表示「沒有值」:兩邊都沒有 → null,否則加總有值的那邊
const addNullable = (a, b) => (a === undefined || a === null ? (b ?? null) : b === undefined || b === null ? a : a + b);

// ── 日期 / 任務鍵 ─────────────────────────────────────────────

export const epochDay = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);
// 每 n 天一個桶:用在「每 3 天重抓一次」這類週期型任務
export const bucket = (iso, n) => Math.floor(epochDay(iso) / n);

// 把 [from, to] 切成每段 ≤ maxSpanDays 天(官方限制單次區間 < 1 年),相鄰兩段重疊 1 天(下一段的第一天當前一段的基準日)。
export function windows(fromIso, toIso, maxSpanDays = 360) {
  if (fromIso > toIso) return [];
  const out = [];
  let from = fromIso;
  while (true) {
    const end = addDaysIso(from, maxSpanDays);
    if (end >= toIso) {
      out.push({ from, to: toIso });
      return out;
    }
    out.push({ from, to: end });
    from = end;
  }
}

// ── 集保戶股權分散 → 衍生值 ──────────────────────────────────

// distributions: [{ range, holders, shares, proportion }];級距列的 range 開頭是下限股數(例 '1-999'、'400001-600000'),
// 另有「合計」與(部分期別)「異動」列。比例以各級距股數 / 合計股數 計算。
export function tdccSummary(distributions) {
  if (!Array.isArray(distributions)) throw new Error('tdcc: distributions is not an array');
  const levels = [];
  let total = null;
  for (const r of distributions) {
    const range = String(r?.range ?? '');
    if (range.includes('合計')) {
      total = { holders: finite(r.holders, 'tdcc total holders'), shares: finite(r.shares, 'tdcc total shares') };
      continue;
    }
    const lower = Number.parseInt(range.replace(/,/g, ''), 10);
    if (!Number.isFinite(lower)) continue; // 「異動」等非級距列
    levels.push({ lower, holders: finite(r.holders, 'tdcc holders'), shares: finite(r.shares, 'tdcc shares') });
  }
  if (levels.length < 10) throw new Error(`tdcc: only ${levels.length} level rows`);
  const sum = (rows, k) => rows.reduce((s, x) => s + x[k], 0);
  const holdersTotal = total?.holders ?? sum(levels, 'holders');
  const sharesTotal = total?.shares ?? sum(levels, 'shares');
  if (!(sharesTotal > 0)) throw new Error('tdcc: zero custody total');
  const group = (pred) => {
    const rows = levels.filter(pred);
    return { holders: sum(rows, 'holders'), ratio: round((100 * sum(rows, 'shares')) / sharesTotal, 2) };
  };
  const big400 = group((l) => l.lower >= 400001);
  const big1000 = group((l) => l.lower >= 1000001);
  const retail50 = group((l) => l.lower <= 40001); // ≤ 50 張(≤ 50,000 股)
  return {
    holders_total: holdersTotal,
    shares_total: sharesTotal,
    big400_holders: big400.holders,
    big400_ratio: big400.ratio,
    big1000_holders: big1000.holders,
    big1000_ratio: big1000.ratio,
    retail50_holders: retail50.holders,
    retail50_ratio: retail50.ratio,
  };
}

export function tdccRows(symbol, res) {
  if (!Array.isArray(res?.data)) throw new Error('tdcc: response has no data array');
  const out = [];
  for (const d of res.data) {
    const date = toIsoDate(d?.date);
    if (!date) throw new Error(`tdcc: bad date ${String(d?.date).slice(0, 12)}`);
    out.push({ symbol, data_date: date, ...tdccSummary(d.distributions) });
  }
  return out;
}

// 集保的取數區間:有資料的標的只補最近(上次日期往前 14 天);沒有的抓近 364 天(1 次呼叫約 52 週)。
export function tdccRange(lastDate, today) {
  return { from: lastDate ? addDaysIso(lastDate, -14) : addDaysIso(today, -364), to: today };
}

// ── ETF 持股 → 逐日列(含前後日差分與退出列)──────────────────

// res.data: [{ date, components: [{ symbol, quantity, weight, quantityChange?, weightChange? }] }],順序不拘。
// baselineDate:該日只當「前一日基準」、不輸出(續抓時從上次最後一天開始,用它做差分)。
// 輸出:每個 (日期, 成分股) 一列;相對前一個有資料日:新增 → 變動 = 持股數;消失 → 補一列 qty=0、變動為負。
export function etfRows(etf, res, { baselineDate = null } = {}) {
  if (!Array.isArray(res?.data)) throw new Error('etf: response has no data array');
  const days = res.data
    .map((d) => ({ date: toIsoDate(d?.date), comps: d?.components }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = [];
  let prev = null; // Map symbol → { q, w }
  for (const day of days) {
    if (!day.date) throw new Error('etf: bad date');
    if (!Array.isArray(day.comps)) throw new Error('etf: components is not an array');
    const cur = new Map();
    const apiChange = new Map();
    for (const c of day.comps) {
      const sym = String(c?.symbol ?? '');
      if (!TW_COMPONENT_OK.test(sym)) continue;
      const q = finite(c.quantity, 'etf quantity');
      const w = num(c.weight) ?? 0;
      // 同日同代號出現多列(例:分多筆揭露)→ 加總;否則主鍵重複會讓整批 upsert 失敗
      const prevSame = cur.get(sym);
      cur.set(sym, { q: q + (prevSame?.q ?? 0), w: w + (prevSame?.w ?? 0) });
      const ac = apiChange.get(sym);
      apiChange.set(sym, { q: addNullable(ac?.q, num(c.quantityChange)), w: addNullable(ac?.w, num(c.weightChange)) });
    }
    if (day.date !== baselineDate) {
      for (const [sym, v] of cur) {
        const p = prev?.get(sym);
        out.push({
          etf_symbol: etf,
          data_date: day.date,
          symbol: sym,
          quantity: v.q,
          weight: round(v.w, 3),
          quantity_change: prev ? v.q - (p?.q ?? 0) : apiChange.get(sym).q,
          weight_change: prev ? round(v.w - (p?.w ?? 0), 3) : apiChange.get(sym).w === null ? null : round(apiChange.get(sym).w, 3),
        });
      }
      if (prev) {
        for (const [sym, p] of prev) {
          if (!cur.has(sym)) {
            out.push({ etf_symbol: etf, data_date: day.date, symbol: sym, quantity: 0, weight: 0, quantity_change: -p.q, weight_change: round(-p.w, 3) });
          }
        }
      }
    }
    prev = cur;
  }
  return out;
}

// ── 三大法人歷史 → 列 ─────────────────────────────────────────

export function instRows(symbol, res) {
  if (!Array.isArray(res?.data)) throw new Error('inst: response has no data array');
  return res.data.map((d) => {
    const date = toIsoDate(d?.date);
    if (!date) throw new Error(`inst: bad date ${String(d?.date).slice(0, 12)}`);
    const net = (x, what) => finite(x?.net, what);
    const f = net(d.foreign, 'inst foreign.net');
    const t = net(d.trust, 'inst trust.net');
    const dl = net(d.dealer, 'inst dealer.net');
    return { symbol, trade_date: date, foreign_net: f, trust_net: t, dealer_net: dl, total_net: f + t + dl };
  });
}

// ── 任務清單(確定性;跑完才記 broker_job_task)──────────────────

// 集保:每檔每 3 天一次(週資料,週五公布,3 天一輪不會落後超過 3 天)。
export function tdccTasks(symbols, today) {
  const b = bucket(today, 3);
  return symbols.filter((s) => SYMBOL_OK.test(s)).map((symbol) => ({ key: `tdcc|${symbol}|${b}`, symbol }));
}

// ETF:每檔每天一次。
export function etfTasks(etfs, today) {
  return etfs.filter((e) => ACTIVE_STOCK_ETF_OK.test(e)).map((etf) => ({ key: `etf|${etf}|${today}`, etf }));
}

// 法人歷史:由新到舊(近年先到),每檔每年一次;當年每週重抓(key 含 ISO 週近似:每 7 天一桶)。
export function instTasks(symbols, today, fromYear = 2013) {
  const year = Number(today.slice(0, 4));
  const wk = bucket(today, 7);
  const tasks = [];
  for (let y = year; y >= fromYear; y--) {
    const from = `${y}-01-01`;
    const to = y === year ? today : `${y}-12-31`;
    for (const symbol of symbols) {
      if (!SYMBOL_OK.test(symbol)) continue;
      tasks.push({ key: y === year ? `inst|${symbol}|${y}|w${wk}` : `inst|${symbol}|${y}`, symbol, from, to });
    }
  }
  return tasks;
}

// 已完成判斷:rows_written ≥ 0 算完成;失敗(-1)3 天內不重試。
export function pendingTasks(tasks, doneRows, nowMs = Date.now()) {
  const done = new Map(doneRows.map((r) => [r.task_key, r]));
  return tasks.filter((t) => {
    const r = done.get(t.key);
    if (!r) return true;
    if (Number(r.rows_written) >= 0) return false;
    return nowMs - Date.parse(r.done_at) > 3 * 86400000;
  });
}

// 分 K → 每日路徑(只存每分鐘高 / 低與開盤,不存分 K 本身)。
export function minuteCompact(res) {
  if (!Array.isArray(res?.data)) throw new Error('minute: response has no data array');
  const bars = res.data
    .map((b) => ({ t: String(b?.date ?? ''), o: num(b?.open), h: num(b?.high), l: num(b?.low), c: num(b?.close) }))
    .filter((b) => b.t && [b.o, b.h, b.l, b.c].every((x) => x !== null && Number.isFinite(x)))
    .sort((a, b) => (a.t < b.t ? -1 : 1));
  if (bars.length === 0) return { bars: 0, open: null, high: null, low: null, close: null, highs: [], lows: [], t0: null };
  return {
    bars: bars.length,
    open: bars[0].o,
    high: Math.max(...bars.map((b) => b.h)),
    low: Math.min(...bars.map((b) => b.l)),
    close: bars.at(-1).c,
    highs: bars.map((b) => b.h),
    lows: bars.map((b) => b.l),
    t0: bars[0].t.slice(11, 16),
  };
}

// 429 判斷(SDK 的錯誤訊息格式未實測,寬鬆比對)
export const isRateLimit = (e) => /429|rate.?limit|too many/i.test(String(e?.message ?? e ?? ''));
// 該日沒有分 K(非交易日 / 早於 2023-05-23):官方回 404
export const isNoData = (e) => /404|not found|no data/i.test(String(e?.message ?? e ?? ''));
