// run-backtest — M10 walk-forward 回測(誠實化 v2)
//
// 流程:
//   1. 驗證 JWT(service_role)+ 參數
//   2. 插入 backtest_runs row(status=running)
//   3. 取 [start,end] 交易日;不夠 → failed
//   4. walk-forward:每 rebalance_days 取一錨點 D
//      - score_universe_at(D) → top_n(用 D 收盤排名,盤後才知道)
//      - exec_model='nextopen'(預設,誠實):D 之後第一個交易日「開盤價」成交
//        exec_model='close'(退版錨點):用錨點當日收盤(= 舊 Phase 0.7 模型)
//      - 漲停鎖死過濾:進場日整天鎖漲停(high==low 且 open≥prev_close×1.095)
//        → 該標的當期跳過(買不到);出場日鎖跌停 → 往後找可成交日開盤
//      - 成本:cost_pct 有給 = flat 覆寫(退版/歸因用);沒給 = 動態 ETF 差別
//        每標的 round-trip = 2×手續費(base×折扣)+ 證交稅(ETF 0.1% / 股 0.3%)
//        ETF 判定 /^00\d/(對齊 holdings 層 v_holdings_full 的 ^00\d+)
//   5. benchmark 0050 同 exec model、gross(不扣成本,保守比較)
//   6. batch insert backtest_trades + summary
//
// 退版安全網(鐵律):exec_model='close' + cost_pct=0.585 必須 byte 級重現
//   Phase 0.7(2024 t10 -35.23/t5 -22.08;2025 t10 +8.41/t5 +17.75)。
//   證明只加「真實度」未動既有邏輯,再切 nextopen+動態成本看誠實值。
//
// 重要:本 EF 不打外部 API,純讀 supabase。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface RunReq {
  name: string;
  start_date: string;
  end_date?: string;
  rebalance_days?: number;
  top_n?: number;
  weight_strategy?: "equal" | "rank";
  benchmark_symbol?: string;
  // 有給 = flat round-trip 成本 %(退版/歸因);不給 = 動態 ETF 差別成本
  cost_pct?: number;
  // 'nextopen'(預設,誠實:隔日開盤成交)| 'close'(退版錨點:錨點收盤成交)
  exec_model?: "nextopen" | "close";
}

interface ScoreRow {
  symbol: string;
  expected_rank: number | string;
}

interface BarRow {
  symbol: string;
  trade_date: string;
  open: number | string | null;
  high: number | string | null;
  low: number | string | null;
  close: number | string;
  adj_factor: number | string | null;
}

interface Bar {
  trade_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
}

interface TradeInsert {
  run_id: string;
  symbol: string;
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  qty: number;
  entry_rank: number | null;
  is_benchmark: boolean;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

function toN(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isEtf(symbol: string): boolean {
  // 對齊 v_holdings_full(migration 3)的 ^00\d+ ETF 判定
  return /^00\d/.test(symbol);
}

async function getTradeDates(
  sb: SupabaseClient,
  start: string,
  end: string,
): Promise<string[]> {
  const dates = new Set<string>();
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from("price_daily")
      .select("trade_date")
      .gte("trade_date", start)
      .lte("trade_date", end)
      .order("trade_date", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`getTradeDates: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as { trade_date: string }[]) dates.add(r.trade_date);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return Array.from(dates).sort();
}

// 取一組 symbol 在 [start,end] 的 bar(adj 套用 o/h/l/c),每 symbol 一個
// 依 trade_date 升冪陣列。Phase 0.5/0.6:全部 ×adj_factor(還原權值)。
async function getBarsRange(
  sb: SupabaseClient,
  symbols: string[],
  start: string,
  end: string,
): Promise<Map<string, Bar[]>> {
  const m = new Map<string, Bar[]>();
  if (symbols.length === 0) return m;
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from("price_daily")
      .select("symbol,trade_date,open,high,low,close,adj_factor")
      .in("symbol", symbols)
      .gte("trade_date", start)
      .lte("trade_date", end)
      .order("trade_date", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`getBarsRange: ${error.message}`);
    const rows = (data as BarRow[] | null) ?? [];
    for (const r of rows) {
      const c = toN(r.close);
      if (c == null) continue;
      const f = toN(r.adj_factor) ?? 1;
      const arr = m.get(r.symbol) ?? [];
      const o = toN(r.open);
      const hi = toN(r.high);
      const lo = toN(r.low);
      arr.push({
        trade_date: r.trade_date,
        open: o == null ? null : o * f,
        high: hi == null ? null : hi * f,
        low: lo == null ? null : lo * f,
        close: c * f,
      });
      m.set(r.symbol, arr);
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return m;
}

// 在 sorted-asc bars 中找「<= date 的最後一根」(close 模型用)
function barAtOrBefore(bars: Bar[] | undefined, date: string): { bar: Bar; idx: number } | null {
  if (!bars || bars.length === 0) return null;
  let res: { bar: Bar; idx: number } | null = null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].trade_date <= date) res = { bar: bars[i], idx: i };
    else break;
  }
  return res;
}

// 在 sorted-asc bars 中找「>= date 的第一根」(nextopen 模型用)
function barAtOrAfter(bars: Bar[] | undefined, date: string): { bar: Bar; idx: number } | null {
  if (!bars || bars.length === 0) return null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].trade_date >= date) return { bar: bars[i], idx: i };
  }
  return null;
}

// 台股 ±10% 鎖死偵測(用 adj 後 o/h/l + 前一根 adj close,tick 容差 0.5%)
function lockedUp(bar: Bar, prevClose: number | null): boolean {
  if (prevClose == null || prevClose <= 0) return false;
  if (bar.high == null || bar.low == null || bar.open == null) return false;
  return bar.high === bar.low && bar.open >= prevClose * 1.095;
}
function lockedDown(bar: Bar, prevClose: number | null): boolean {
  if (prevClose == null || prevClose <= 0) return false;
  if (bar.high == null || bar.low == null || bar.open == null) return false;
  return bar.high === bar.low && bar.open <= prevClose * 0.905;
}

function computeMaxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length < 2) return 0;
  let peak = equityCurve[0];
  let maxDD = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD * 100;
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86400 * 1000)
    .toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return Response.json({ error: "missing bearer" }, { status: 401 });
  }
  let role: unknown;
  try {
    role = decodeJwtPayload(auth.slice(7)).role;
  } catch {
    return Response.json({ error: "invalid jwt" }, { status: 401 });
  }
  if (role !== "service_role") {
    return Response.json({ error: "forbidden", role }, { status: 403 });
  }

  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SERVICE_ROLE) {
    return Response.json(
      { error: "missing SUPABASE_SERVICE_ROLE_KEY env" },
      { status: 500 },
    );
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);

  let body: RunReq;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }
  if (!body.name) return Response.json({ error: "missing name" }, { status: 400 });
  if (!body.start_date) {
    return Response.json({ error: "missing start_date" }, { status: 400 });
  }
  const endDate = body.end_date ?? new Date().toISOString().slice(0, 10);
  const rebalanceDays = body.rebalance_days ?? 20;
  const topN = body.top_n ?? 10;
  const weightStrategy = body.weight_strategy ?? "equal";
  const benchmarkSymbol = body.benchmark_symbol ?? "0050";
  const execModel = body.exec_model === "close" ? "close" : "nextopen";
  const costOverride = body.cost_pct == null ? null : body.cost_pct;
  if (rebalanceDays < 1 || rebalanceDays > 250) {
    return Response.json({ error: "rebalance_days out of range" }, { status: 400 });
  }
  if (topN < 1 || topN > 100) {
    return Response.json({ error: "top_n out of range" }, { status: 400 });
  }
  if (costOverride != null && (costOverride < 0 || costOverride > 5)) {
    return Response.json({ error: "cost_pct out of range (0-5)" }, { status: 400 });
  }

  // 動態 ETF 差別成本(cost_pct 未給時)— 從 app_settings 拿,對齊 holdings 層
  let dynCommRT = 0; // round-trip 手續費 fraction
  let dynTaxStock = 0;
  let dynTaxEtf = 0;
  if (costOverride == null) {
    const { data: cfg } = await sb
      .from("app_settings")
      .select("key,value")
      .in("key", ["commission_base_rate", "commission_discount", "sell_tax_stock", "sell_tax_etf"]);
    const cm = new Map((cfg ?? []).map((r) => [r.key as string, Number(r.value)]));
    const base = cm.get("commission_base_rate") ?? 0.001425;
    const disc = cm.get("commission_discount") ?? 1;
    dynCommRT = base * disc * 2;
    dynTaxStock = cm.get("sell_tax_stock") ?? 0.003;
    dynTaxEtf = cm.get("sell_tax_etf") ?? 0.001;
  }
  const costFor = (symbol: string): number =>
    costOverride != null
      ? costOverride / 100
      : dynCommRT + (isEtf(symbol) ? dynTaxEtf : dynTaxStock);

  const params = {
    start_date: body.start_date,
    end_date: endDate,
    rebalance_days: rebalanceDays,
    top_n: topN,
    weight_strategy: weightStrategy,
    benchmark_symbol: benchmarkSymbol,
    exec_model: execModel,
    cost_pct: costOverride, // null = 動態 ETF 差別
    cost_model: costOverride == null ? "dynamic_etf_diff" : "flat_override",
  };

  const { data: runRow, error: runErr } = await sb
    .from("backtest_runs")
    .insert({
      name: body.name,
      params,
      status: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (runErr || !runRow) {
    return Response.json(
      { error: `insert backtest_runs failed: ${runErr?.message}` },
      { status: 500 },
    );
  }
  const runId = runRow.id as string;

  async function failRun(reason: string, extra: Record<string, unknown> = {}) {
    await sb
      .from("backtest_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error: reason.slice(0, 1000),
        summary: { reason, ...extra },
      })
      .eq("id", runId);
    return Response.json({ run_id: runId, status: "failed", reason, ...extra });
  }

  let tradeDates: string[];
  try {
    tradeDates = await getTradeDates(sb, body.start_date, endDate);
  } catch (e) {
    return await failRun(
      `getTradeDates_error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (tradeDates.length < rebalanceDays * 2) {
    return await failRun("insufficient_data", {
      message: `price_daily 在 [${body.start_date}, ${endDate}] 只有 ${tradeDates.length} 個交易日,需 ≥ ${rebalanceDays * 2}`,
      trade_days_found: tradeDates.length,
      trade_days_required: rebalanceDays * 2,
    });
  }

  // walk-forward 錨點:rankIdx 用收盤排名;nextopen 進出場各 +1 交易日
  interface Pt { rankIdx: number; entryIdx: number; exitIdx: number; }
  const points: Pt[] = [];
  const last = tradeDates.length - 1;
  for (let i = 0; i + rebalanceDays < tradeDates.length; i += rebalanceDays) {
    if (execModel === "close") {
      points.push({ rankIdx: i, entryIdx: i, exitIdx: i + rebalanceDays });
    } else {
      points.push({
        rankIdx: i,
        entryIdx: Math.min(i + 1, last),
        exitIdx: Math.min(i + rebalanceDays + 1, last),
      });
    }
  }
  if (points.length === 0) {
    return await failRun("no_rebalance_points", {
      trade_days_found: tradeDates.length, rebalance_days: rebalanceDays,
    });
  }

  const trades: TradeInsert[] = [];
  const periodReturns: number[] = [];
  let equity = 1.0;
  let benchEquity = 1.0;
  const equityCurve: number[] = [equity];
  const benchEquityCurve: number[] = [benchEquity];
  let skippedLimitUp = 0;

  for (const pt of points) {
    const rankDate = tradeDates[pt.rankIdx];
    const entryExecDate = tradeDates[pt.entryIdx];
    const exitExecDate = tradeDates[pt.exitIdx];

    const { data: ranks, error: rankErr } = await sb
      .rpc("score_universe_at", { as_of_date: rankDate })
      .order("expected_rank", { ascending: true })
      .limit(topN);
    if (rankErr) {
      return await failRun(`score_universe_at_error: ${rankErr.message}`,
        { rebalance_date: rankDate });
    }
    const rankRows = (ranks as ScoreRow[] | null) ?? [];
    if (rankRows.length === 0) {
      periodReturns.push(0);
      equityCurve.push(equity);
      benchEquityCurve.push(benchEquity);
      continue;
    }

    // 一次抓本期所有 symbol + benchmark 的 bar 區間
    // 涵蓋 entry 前一根(prev_close 算鎖死)~ exit 之後 8 交易日(出場跌停往後找)
    const symbols = rankRows.map((r) => r.symbol);
    const allSyms = Array.from(new Set([...symbols, benchmarkSymbol]));
    const fetchStart = addDays(tradeDates[Math.max(0, pt.rankIdx - 1)], -10);
    const fetchEnd = addDays(tradeDates[Math.min(last, pt.exitIdx + 8)], 2);
    const bars = await getBarsRange(sb, allSyms, fetchStart, fetchEnd);

    // 取進場價(含鎖死處理)
    function entryPrice(sym: string): { price: number; date: string } | null {
      const arr = bars.get(sym);
      if (execModel === "close") {
        const hit = barAtOrBefore(arr, rankDate);
        return hit ? { price: hit.bar.close, date: hit.bar.trade_date } : null;
      }
      const hit = barAtOrAfter(arr, entryExecDate);
      if (!hit) return null;
      const prevClose = hit.idx > 0 ? arr![hit.idx - 1].close : null;
      if (lockedUp(hit.bar, prevClose)) return null; // 鎖漲停買不到 → 跳過
      const px = hit.bar.open ?? hit.bar.close; // open 缺值 fallback close
      return { price: px, date: hit.bar.trade_date };
    }
    // 取出場價(出場鎖跌停 → 往後找可成交日)
    function exitPrice(sym: string): { price: number; date: string } | null {
      const arr = bars.get(sym);
      if (execModel === "close") {
        const hit = barAtOrBefore(arr, exitExecDate);
        return hit ? { price: hit.bar.close, date: hit.bar.trade_date } : null;
      }
      let hit = barAtOrAfter(arr, exitExecDate);
      if (!hit) return null;
      let guard = 0;
      while (hit && guard < 6) {
        const prevClose = hit.idx > 0 ? arr![hit.idx - 1].close : null;
        if (!lockedDown(hit.bar, prevClose)) {
          return { price: hit.bar.open ?? hit.bar.close, date: hit.bar.trade_date };
        }
        hit = hit.idx + 1 < arr!.length ? { bar: arr![hit.idx + 1], idx: hit.idx + 1 } : null;
        guard++;
      }
      // 連續鎖跌停:用最後看到的(認賠最差價)
      const fb = barAtOrAfter(arr, exitExecDate);
      return fb ? { price: fb.bar.open ?? fb.bar.close, date: fb.bar.trade_date } : null;
    }

    const validReturns: number[] = [];
    for (const r of rankRows) {
      const e = entryPrice(r.symbol);
      const x = exitPrice(r.symbol);
      if (!e || !x || e.price <= 0) {
        if (!e) skippedLimitUp++; // 含買不到(鎖漲停/無資料)
        continue;
      }
      const ret = (x.price - e.price) / e.price - costFor(r.symbol);
      trades.push({
        run_id: runId, symbol: r.symbol,
        entry_date: e.date, exit_date: x.date,
        entry_price: e.price, exit_price: x.price,
        qty: 1, entry_rank: Number(r.expected_rank) || null,
        is_benchmark: false,
      });
      validReturns.push(ret);
    }
    const periodReturn = validReturns.length > 0
      ? validReturns.reduce((a, b) => a + b, 0) / validReturns.length
      : 0;
    periodReturns.push(periodReturn);
    equity *= 1 + periodReturn;
    equityCurve.push(equity);

    // benchmark(同 exec model、gross 不扣成本)
    const arrB = bars.get(benchmarkSymbol);
    let be: number | null = null, bx: number | null = null;
    let beD = "", bxD = "";
    if (execModel === "close") {
      const h1 = barAtOrBefore(arrB, rankDate);
      const h2 = barAtOrBefore(arrB, exitExecDate);
      if (h1) { be = h1.bar.close; beD = h1.bar.trade_date; }
      if (h2) { bx = h2.bar.close; bxD = h2.bar.trade_date; }
    } else {
      const h1 = barAtOrAfter(arrB, entryExecDate);
      const h2 = barAtOrAfter(arrB, exitExecDate);
      if (h1) { be = h1.bar.open ?? h1.bar.close; beD = h1.bar.trade_date; }
      if (h2) { bx = h2.bar.open ?? h2.bar.close; bxD = h2.bar.trade_date; }
    }
    if (be != null && bx != null && be > 0) {
      const bRet = (bx - be) / be;
      trades.push({
        run_id: runId, symbol: benchmarkSymbol,
        entry_date: beD, exit_date: bxD,
        entry_price: be, exit_price: bx,
        qty: 1, entry_rank: null, is_benchmark: true,
      });
      benchEquity *= 1 + bRet;
      benchEquityCurve.push(benchEquity);
    } else {
      benchEquityCurve.push(benchEquity);
    }
  }

  if (trades.length > 0) {
    const batchSize = 500;
    for (let i = 0; i < trades.length; i += batchSize) {
      const batch = trades.slice(i, i + batchSize);
      const { error } = await sb.from("backtest_trades").insert(batch);
      if (error) return await failRun(`insert_trades_error: ${error.message}`);
    }
  }

  const strategyTrades = trades.filter((t) => !t.is_benchmark);
  const wins = strategyTrades.filter(
    (t) => (t.exit_price - t.entry_price) / t.entry_price - costFor(t.symbol) > 0,
  ).length;
  const winRate = strategyTrades.length > 0
    ? (wins / strategyTrades.length) * 100 : 0;
  const totalReturnPct = (equity - 1) * 100;
  const benchTotalReturnPct = (benchEquity - 1) * 100;
  const totalTradeDays = points.length * rebalanceDays;
  const annualReturnPct = totalTradeDays > 0
    ? (Math.pow(equity, 252 / totalTradeDays) - 1) * 100 : 0;
  const maxDD = computeMaxDrawdown(equityCurve);

  let sharpe: number | null = null;
  if (periodReturns.length >= 2) {
    const mean = periodReturns.reduce((a, b) => a + b, 0) / periodReturns.length;
    const variance = periodReturns.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
      (periodReturns.length - 1);
    const std = Math.sqrt(variance);
    if (Number.isFinite(std) && std > 0) {
      const ppy = 252 / rebalanceDays;
      sharpe = Number(((mean * ppy) / (std * Math.sqrt(ppy))).toFixed(4));
    }
  }

  const summary = {
    win_rate: Number(winRate.toFixed(2)),
    total_return_pct: Number(totalReturnPct.toFixed(2)),
    annual_return_pct: Number(annualReturnPct.toFixed(2)),
    max_drawdown_pct: Number(maxDD.toFixed(2)),
    sharpe,
    alpha_vs_benchmark: Number((totalReturnPct - benchTotalReturnPct).toFixed(2)),
    benchmark_return_pct: Number(benchTotalReturnPct.toFixed(2)),
    n_trades: strategyTrades.length,
    n_rebalances: points.length,
    skipped_limit_up_or_nodata: skippedLimitUp,
    exec_model: execModel,
    cost_model: costOverride == null ? "dynamic_etf_diff" : `flat_${costOverride}`,
    equity_curve: equityCurve.map((v) => Number(v.toFixed(4))),
    benchmark_equity_curve: benchEquityCurve.map((v) => Number(v.toFixed(4))),
    rebalance_dates: points.map((p) => tradeDates[p.rankIdx]),
  };

  await sb
    .from("backtest_runs")
    .update({
      status: "finished",
      finished_at: new Date().toISOString(),
      summary,
    })
    .eq("id", runId);

  return Response.json({ run_id: runId, status: "finished", summary });
});
