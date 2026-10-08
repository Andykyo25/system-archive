// 背景工作(jobs):每日同步「結案之後」才執行,用有時間預算的方式逐步補富邦行情資料。
// 失敗、逾時、被限流都只影響 jobs 自己(有自己的 fetch_log),不會碰到每日庫存同步。
//
// 進度記在 broker_job_task(job, task_key):任務清單是確定性的(jobs-lib.mjs),跑完才記;
// 每次執行挑「尚未完成」的前面幾個做,預算用完就停,下次接著做。
// 速率:全域至少相隔 1.1 秒(歷史行情上限 60 次 / 分);遇 429 等 65 秒重試一次,再 429 就停止本次所有工作。

import { taipeiToday } from './lib.mjs';
import { etfRows, etfTasks, pendingTasks, tdccRange, tdccRows, tdccTasks, windows, isRateLimit } from './jobs-lib.mjs';

const ETF_BACKFILL_FROM = '2025-01-01';
const MIN_GAP_MS = 1100;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 取回全部列(PostgREST 預設單次最多 1000 列)。呼叫端要自己帶穩定的 order。
async function fetchAll(sb, path, page = 1000) {
  const out = [];
  for (let offset = 0; ; offset += page) {
    const rows = await sb(`${path}${path.includes('?') ? '&' : '?'}limit=${page}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

async function upsertChunks(sb, table, conflict, rows, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    await sb(`/${table}?on_conflict=${conflict}`, {
      method: 'POST',
      body: rows.slice(i, i + size),
      prefer: 'resolution=merge-duplicates',
    });
  }
}

// 宇宙 = stock_universe ∪ 曾交易過的股票
async function universeSymbols(sb) {
  const [u, h] = await Promise.all([
    fetchAll(sb, '/stock_universe?select=symbol&order=symbol'),
    fetchAll(sb, '/holdings_transactions?select=symbol&order=id'),
  ]);
  return [...new Set([...u, ...h].map((r) => r.symbol))].sort();
}

// ── 各工作 ─────────────────────────────────────────────────────

async function jobEtf(ctx) {
  const { sb, today } = ctx;
  const etfs = (await fetchAll(sb, '/etf_metadata?select=symbol&is_active_etf=eq.true&order=symbol')).map((r) => r.symbol);
  const last = new Map((await fetchAll(sb, '/v_etf_last_date?select=etf_symbol,last_date&order=etf_symbol')).map((r) => [r.etf_symbol, r.last_date]));
  return ctx.runTasks('etf', etfTasks(etfs, today), async (t) => {
    const lastDate = last.get(t.etf) ?? null;
    let baseline = lastDate; // 續抓:上次最後一天只當基準(差分用),不重複輸出
    let total = 0;
    for (const w of windows(lastDate ?? ETF_BACKFILL_FROM, today)) {
      const res = await ctx.call(() => ctx.stock.ownership.etfHoldings({ symbol: t.etf, from: w.from, to: w.to }));
      const rows = etfRows(t.etf, res, { baselineDate: baseline });
      await upsertChunks(sb, 'etf_holdings_daily', 'etf_symbol,data_date,symbol', rows);
      total += rows.length;
      baseline = w.to;
    }
    return total;
  });
}

async function jobTdcc(ctx) {
  const { sb, today } = ctx;
  const symbols = await universeSymbols(sb);
  const last = new Map((await fetchAll(sb, '/v_tdcc_last_date?select=symbol,last_date&order=symbol')).map((r) => [r.symbol, r.last_date]));
  return ctx.runTasks('tdcc', tdccTasks(symbols, today), async (t) => {
    const res = await ctx.call(() => ctx.stock.ownership.tdccDistribution({ symbol: t.symbol, ...tdccRange(last.get(t.symbol) ?? null, today) }));
    const rows = tdccRows(t.symbol, res);
    await upsertChunks(sb, 'tdcc_distribution_weekly', 'symbol,data_date', rows);
    return rows.length;
  });
}

// 登錄順序 = 執行順序:小而每日的先跑,大回填吃剩餘預算。
export const JOB_IMPL = { etf: jobEtf, tdcc: jobTdcc };
export const ALL_JOBS = Object.keys(JOB_IMPL);

// ── 編排 ───────────────────────────────────────────────────────

export async function runJobs({
  sdk,
  sb,
  enabled = ALL_JOBS,
  budgetMs = 420_000,
  gapMs = MIN_GAP_MS,
  today = taipeiToday(),
  sleep = defaultSleep,
  now = Date.now,
}) {
  const deadline = now() + budgetMs;
  const summary = {};
  const notes = [];
  let stopped = null;
  let lastCall = 0;

  const call = async (fn) => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + gapMs - now();
      if (wait > 0) await sleep(wait);
      lastCall = now();
      try {
        return await fn();
      } catch (e) {
        if (!isRateLimit(e)) throw e;
        if (attempt >= 1 || now() + 65_000 > deadline) {
          stopped = 'rate limited (429)';
          throw e;
        }
        await sleep(65_000);
      }
    }
  };

  const markDone = (job, key, rows) =>
    sb('/broker_job_task?on_conflict=job,task_key', {
      method: 'POST',
      body: [{ job, task_key: key, rows_written: rows, done_at: new Date().toISOString() }],
      prefer: 'resolution=merge-duplicates',
    });

  const ctx = { sb, call, today, stock: null };
  ctx.runTasks = async (job, tasks, exec) => {
    const done = await fetchAll(sb, `/broker_job_task?select=task_key,rows_written,done_at&job=eq.${job}&order=task_key`);
    const pending = pendingTasks(tasks, done, now());
    let ran = 0;
    let rows = 0;
    let failed = 0;
    for (const t of pending) {
      if (stopped || deadline - now() < 4000) break;
      try {
        const n = await exec(t);
        await markDone(job, t.key, n);
        ran++;
        rows += n;
      } catch (e) {
        if (stopped) break; // 被限流:這個任務沒做壞,不記失敗,下次再來
        failed++;
        notes.push(`${job} ${t.key}: ${String(e?.message ?? e).slice(0, 100)}`);
        await markDone(job, t.key, -1).catch(() => {});
      }
    }
    return { tasks: tasks.length, ran, rows, failed, left: pending.length - ran - failed };
  };

  try {
    sdk.initRealtime();
    ctx.stock = sdk.marketdata.restClient.stock;
  } catch (e) {
    return { ok: false, summary, notes: [`init: ${String(e?.message ?? e).slice(0, 100)}`], stopped };
  }

  let ok = true;
  for (const name of enabled) {
    const impl = JOB_IMPL[name];
    if (!impl) {
      notes.push(`unknown job: ${name}`);
      continue;
    }
    if (stopped || deadline - now() < 4000) {
      summary[name] = { skipped: stopped ?? 'out of budget' };
      continue;
    }
    try {
      summary[name] = await impl(ctx);
    } catch (e) {
      ok = false;
      summary[name] = { error: String(e?.message ?? e).slice(0, 100) };
    }
  }
  return { ok: ok && !notes.some((n) => n.startsWith('init')), summary, notes, stopped };
}
