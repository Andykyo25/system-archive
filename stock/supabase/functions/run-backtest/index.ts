// run-backtest — M10 walk-forward 回測
//
// 用法:
//   curl -X POST '<host>/functions/v1/run-backtest' \
//     -H 'Authorization: Bearer <service_role_jwt>' \
//     -H 'Content-Type: application/json' \
//     -d '{
//       "name":"M10 smoke",
//       "start_date":"2024-06-01",
//       "end_date":"2024-12-31",
//       "rebalance_days":20,
//       "top_n":10,
//       "weight_strategy":"equal",
//       "benchmark_symbol":"0050"
//     }'
//
// 流程:
//   1. 驗證 JWT(service_role)+ 參數
//   2. 插入 backtest_runs row(status=running)
//   3. 從 price_daily 取 trade_date 在 [start_date, end_date] 區間的所有「交易日」
//   4. 不夠 → status=failed,summary.reason=insufficient_data
//   5. walk-forward:每 rebalance_days 取一個錨點(rebalance_date)
//      - 呼叫 score_universe_at(rebalance_date) → top_n symbol
//      - entry_price = 該 symbol 在 rebalance_date 的 close(取 <= rebalance_date 最後一筆有資料的)
//      - exit_date = 下一個錨點(或 end_date 最後一日)
//      - exit_price = exit_date 那天的 close
//   6. benchmark 0050 同樣 schedule entry / exit(同期等權持有)
//   7. batch insert backtest_trades + compute summary
//
// 重要:本 EF 不打 FinMind / 不打外部 API,純讀 supabase。

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
}

interface ScoreRow {
  symbol: string;
  weighted_score: number | string | null;
  expected_rank: number | string;
  latest_close: number | string | null;
  latest_date: string | null;
}

interface PriceRow {
  symbol: string;
  trade_date: string;
  close: number | string;
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

// 取得交易日(從 price_daily 撈 distinct trade_date)
async function getTradeDates(
  sb: SupabaseClient,
  start: string,
  end: string,
): Promise<string[]> {
  // 用 RPC 或 view 較簡潔;先用 select distinct trade_date(會被 supabase limit 1000,所以分頁)
  const dates = new Set<string>();
  let offset = 0;
  const pageSize = 1000;
  // benchmark 0050 一定有交易;若沒有 fallback 用 universe 第一筆
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

// 在某日(或之前最近一個交易日)取一組 symbol 的 close
async function getClosesAt(
  sb: SupabaseClient,
  symbols: string[],
  date: string,
  windowDays = 7,
): Promise<Map<string, { close: number; trade_date: string }>> {
  if (symbols.length === 0) return new Map();
  const minDate = new Date(
    new Date(date).getTime() - windowDays * 86400 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const { data, error } = await sb
    .from("price_daily")
    .select("symbol,trade_date,close")
    .in("symbol", symbols)
    .gte("trade_date", minDate)
    .lte("trade_date", date)
    .order("trade_date", { ascending: false });
  if (error) throw new Error(`getClosesAt: ${error.message}`);
  // distinct on (symbol) order by trade_date desc — JS-side 取每 symbol 最新一筆
  const m = new Map<string, { close: number; trade_date: string }>();
  for (const r of (data as PriceRow[] | null) ?? []) {
    if (m.has(r.symbol)) continue;
    const c = toN(r.close);
    if (c == null) continue;
    m.set(r.symbol, { close: c, trade_date: r.trade_date });
  }
  return m;
}

interface RebalancePoint {
  rebalance_date: string; // YYYY-MM-DD,取自 tradeDates 的錨點
  exit_date: string;
}

function pickRebalancePoints(
  tradeDates: string[],
  rebalanceDays: number,
): RebalancePoint[] {
  // 每 rebalanceDays 取一個 entry,exit = 下一個 entry(最後一個 entry exit = tradeDates 最後一日)
  const points: RebalancePoint[] = [];
  if (tradeDates.length < rebalanceDays + 1) return points;
  for (let i = 0; i + rebalanceDays < tradeDates.length; i += rebalanceDays) {
    points.push({
      rebalance_date: tradeDates[i],
      exit_date: tradeDates[i + rebalanceDays],
    });
  }
  return points;
}

// drawdown 用 portfolio equity curve(rebalance 結束時 portfolio value)
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

Deno.serve(async (req: Request) => {
  // ---------- auth ----------
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

  // ---------- parse body ----------
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
  if (rebalanceDays < 1 || rebalanceDays > 250) {
    return Response.json({ error: "rebalance_days out of range" }, { status: 400 });
  }
  if (topN < 1 || topN > 100) {
    return Response.json({ error: "top_n out of range" }, { status: 400 });
  }

  const params = {
    start_date: body.start_date,
    end_date: endDate,
    rebalance_days: rebalanceDays,
    top_n: topN,
    weight_strategy: weightStrategy,
    benchmark_symbol: benchmarkSymbol,
  };

  // ---------- insert run row ----------
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

  // helper for early exit
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
    return Response.json({
      run_id: runId,
      status: "failed",
      reason,
      ...extra,
    });
  }

  // ---------- pre-check: trade dates in range ----------
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

  // ---------- walk-forward ----------
  const points = pickRebalancePoints(tradeDates, rebalanceDays);
  if (points.length === 0) {
    return await failRun("no_rebalance_points", {
      trade_days_found: tradeDates.length,
      rebalance_days: rebalanceDays,
    });
  }

  const trades: TradeInsert[] = [];
  const periodReturns: number[] = []; // 每 rebalance 期的 portfolio 報酬
  const benchmarkPeriodReturns: number[] = [];
  let equity = 1.0;
  let benchEquity = 1.0;
  const equityCurve: number[] = [equity];
  const benchEquityCurve: number[] = [benchEquity];

  for (const pt of points) {
    // 1. 取得 entry_date 視角的 top_n
    const { data: ranks, error: rankErr } = await sb
      .rpc("score_universe_at", { as_of_date: pt.rebalance_date })
      .order("expected_rank", { ascending: true })
      .limit(topN);
    if (rankErr) {
      return await failRun(
        `score_universe_at_error: ${rankErr.message}`,
        { rebalance_date: pt.rebalance_date },
      );
    }
    const rankRows = (ranks as ScoreRow[] | null) ?? [];
    if (rankRows.length === 0) {
      // 該日沒有任何 symbol 有 score(資料完全不足)— 跳過該期但不 fail
      periodReturns.push(0);
      benchmarkPeriodReturns.push(0);
      equityCurve.push(equity);
      benchEquityCurve.push(benchEquity);
      continue;
    }

    // 2. 取 entry close & exit close
    const symbols = rankRows.map((r) => r.symbol);
    const entryCloses = await getClosesAt(sb, symbols, pt.rebalance_date);
    const exitCloses = await getClosesAt(sb, symbols, pt.exit_date);

    // benchmark
    const benchEntry = await getClosesAt(sb, [benchmarkSymbol], pt.rebalance_date);
    const benchExit = await getClosesAt(sb, [benchmarkSymbol], pt.exit_date);

    // 3. 計算該期 portfolio 報酬(等權)
    const validReturns: number[] = [];
    let validCount = 0;
    for (const r of rankRows) {
      const e = entryCloses.get(r.symbol);
      const x = exitCloses.get(r.symbol);
      if (!e || !x) continue;
      const ret = (x.close - e.close) / e.close;
      trades.push({
        run_id: runId,
        symbol: r.symbol,
        entry_date: e.trade_date,
        exit_date: x.trade_date,
        entry_price: e.close,
        exit_price: x.close,
        qty: 1,
        entry_rank: Number(r.expected_rank) || null,
        is_benchmark: false,
      });
      validReturns.push(ret);
      validCount++;
    }
    const periodReturn =
      validReturns.length > 0
        ? validReturns.reduce((a, b) => a + b, 0) / validReturns.length
        : 0;
    periodReturns.push(periodReturn);
    equity *= 1 + periodReturn;
    equityCurve.push(equity);

    // benchmark trade(若有資料)
    const be = benchEntry.get(benchmarkSymbol);
    const bx = benchExit.get(benchmarkSymbol);
    if (be && bx) {
      const bRet = (bx.close - be.close) / be.close;
      trades.push({
        run_id: runId,
        symbol: benchmarkSymbol,
        entry_date: be.trade_date,
        exit_date: bx.trade_date,
        entry_price: be.close,
        exit_price: bx.close,
        qty: 1,
        entry_rank: null,
        is_benchmark: true,
      });
      benchmarkPeriodReturns.push(bRet);
      benchEquity *= 1 + bRet;
      benchEquityCurve.push(benchEquity);
    } else {
      benchmarkPeriodReturns.push(0);
      benchEquityCurve.push(benchEquity);
    }
  }

  // ---------- batch insert trades ----------
  if (trades.length > 0) {
    // 每 500 一批
    const batchSize = 500;
    for (let i = 0; i < trades.length; i += batchSize) {
      const batch = trades.slice(i, i + batchSize);
      const { error } = await sb.from("backtest_trades").insert(batch);
      if (error) {
        return await failRun(`insert_trades_error: ${error.message}`);
      }
    }
  }

  // ---------- compute summary ----------
  const strategyTrades = trades.filter((t) => !t.is_benchmark);
  const wins = strategyTrades.filter(
    (t) => t.exit_price > t.entry_price,
  ).length;
  const winRate =
    strategyTrades.length > 0
      ? (wins / strategyTrades.length) * 100
      : 0;
  const totalReturnPct = (equity - 1) * 100;
  const benchTotalReturnPct = (benchEquity - 1) * 100;

  // annualize:periodReturns.length 期數,每期 rebalance_days 個交易日
  // 年化:(1 + total) ^ (252 / total_trade_days) - 1
  const totalTradeDays = points.length * rebalanceDays;
  const annualReturnPct =
    totalTradeDays > 0
      ? (Math.pow(equity, 252 / totalTradeDays) - 1) * 100
      : 0;
  const maxDD = computeMaxDrawdown(equityCurve);

  // sharpe-ish:把 periodReturns 視為每期報酬,annualize factor = sqrt(252 / rebalance_days)
  let sharpe: number | null = null;
  if (periodReturns.length >= 2) {
    const mean =
      periodReturns.reduce((a, b) => a + b, 0) / periodReturns.length;
    const variance =
      periodReturns.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
      (periodReturns.length - 1);
    const std = Math.sqrt(variance);
    if (Number.isFinite(std) && std > 0) {
      const periodsPerYear = 252 / rebalanceDays;
      sharpe = Number(
        ((mean * periodsPerYear) / (std * Math.sqrt(periodsPerYear))).toFixed(
          4,
        ),
      );
    }
  }

  const summary = {
    win_rate: Number(winRate.toFixed(2)),
    total_return_pct: Number(totalReturnPct.toFixed(2)),
    annual_return_pct: Number(annualReturnPct.toFixed(2)),
    max_drawdown_pct: Number(maxDD.toFixed(2)),
    sharpe,
    alpha_vs_benchmark: Number(
      (totalReturnPct - benchTotalReturnPct).toFixed(2),
    ),
    benchmark_return_pct: Number(benchTotalReturnPct.toFixed(2)),
    n_trades: strategyTrades.length,
    n_rebalances: points.length,
    equity_curve: equityCurve.map((v) => Number(v.toFixed(4))),
    benchmark_equity_curve: benchEquityCurve.map((v) => Number(v.toFixed(4))),
    rebalance_dates: points.map((p) => p.rebalance_date),
  };

  await sb
    .from("backtest_runs")
    .update({
      status: "finished",
      finished_at: new Date().toISOString(),
      summary,
    })
    .eq("id", runId);

  return Response.json({
    run_id: runId,
    status: "finished",
    summary,
  });
});
