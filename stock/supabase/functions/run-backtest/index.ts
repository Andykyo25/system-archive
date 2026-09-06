// run-backtest — daily-stop-v4 / daily-cash-ledger-v1 (2026-09-06)
// New runs use daily cash/position accounting and daily marked equity. Pending
// sales keep capital invested until an executable fill; unresolved end-of-run
// exits remain open positions. Previously stored runs are never rewritten.
// Adjusted fractional units, no slippage; close remains a diagnostic model.
//
// 流程:
//   1. 比對可信 service/cron secret + 驗證參數
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
// close is retained only as a diagnostic model; it cannot use intraday stops.
//
// 重要:本 EF 不打外部 API,純讀 supabase。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { stopExit, nextSell } from "./execution.ts";
import { authorizeServiceRequest } from "../_shared/authorize.ts";
import {
  ACCOUNTING_VERSION, INITIAL_CAPITAL, runDailyLedger,
  type AllocationWindow, type LedgerFill, type LedgerOrder,
} from "./ledger.ts";

const EXECUTION_VERSION = "daily-stop-v4";

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
  // M9.4b:>0 啟用停損(持有期 low 跌破 entry×(1-x/100) 即誠實出場);
  //   0/未給=無停損；新帳務版本不與舊結果逐位元相容
  stop_loss_pct?: number;
  // 波動正規化停損(L43,與 stop_loss_pct 三者互斥,多個 >0 → 400):
  //   A. stop_atr_mult>0:進場前一日 ATR14 算一次,stopLine=entry−k×ATR(全期固定)
  stop_atr_mult?: number;
  //   B. stop_chandelier_mult>0:僅用前一日高價與 ATR；停損線只向上移動
  stop_chandelier_mult?: number;
  // 進場模型(E 工程,2026-06-10,「好股等好價」timing 驗證):
  //   'immediate'(預設 = 現行為,nextopen 開盤市價)
  //   'pullback_ma20':限價 = rankDate 的 MA20(EF 內 bars 自算,同 adj 口徑)。
  //     D+1 起 entry_wait_days 個交易日內:open<=limit 用 open 成交(跳空低開),
  //     否則 low<=limit 用 limit 成交(觸價);等嘸/MA20 種子不足 → 該檔本期 skip
  //     (計 entry_not_filled / entry_limit_na,誠實不 fallback)。出場時點不變。
  //   未給/immediate → 直接採預定開盤價
  entry_model?: "immediate" | "pullback_ma20";
  entry_wait_days?: number; // pullback 等待窗(交易日),預設 10,1-40
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
      .order("symbol", { ascending: true })
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
      .order("symbol", { ascending: true })
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

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86400 * 1000)
    .toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SERVICE_ROLE) {
    return Response.json(
      { error: "missing SUPABASE_SERVICE_ROLE_KEY env" },
      { status: 500 },
    );
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);
  const authorized = await authorizeServiceRequest(req, SERVICE_ROLE, async () => {
    const { data, error } = await sb.rpc("read_edge_function_auth");
    return error || typeof data !== "string" ? null : data;
  });
  if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });

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
  if (weightStrategy !== "equal") return Response.json({ error: "only equal weights are implemented" }, { status: 400 });
  const benchmarkSymbol = body.benchmark_symbol ?? "0050";
  const execModel = body.exec_model === "close" ? "close" : "nextopen";
  const costOverride = body.cost_pct == null ? null : body.cost_pct;
  // 停損 %:0/未給 = 無停損
  const stopLossPct = body.stop_loss_pct == null ? 0 : body.stop_loss_pct;
  // 波動正規化停損(L43):ATR-static / Chandelier,k 倍數;0/未給 = 不啟用
  const stopAtrMult = body.stop_atr_mult == null ? 0 : body.stop_atr_mult;
  const stopChandelierMult =
    body.stop_chandelier_mult == null ? 0 : body.stop_chandelier_mult;
  if (!Number.isInteger(rebalanceDays) || rebalanceDays < 1 || rebalanceDays > 250) {
    return Response.json({ error: "rebalance_days out of range" }, { status: 400 });
  }
  if (!Number.isInteger(topN) || topN < 1 || topN > 100) {
    return Response.json({ error: "top_n out of range" }, { status: 400 });
  }
  if (costOverride != null && (!Number.isFinite(costOverride) || costOverride < 0 || costOverride > 5)) {
    return Response.json({ error: "cost_pct out of range (0-5)" }, { status: 400 });
  }
  if (!Number.isFinite(stopLossPct) || stopLossPct < 0 || stopLossPct > 50) {
    return Response.json({ error: "stop_loss_pct out of range (0-50)" }, { status: 400 });
  }
  if (!Number.isFinite(stopAtrMult) || stopAtrMult < 0 || stopAtrMult > 20) {
    return Response.json({ error: "stop_atr_mult out of range (0-20)" }, { status: 400 });
  }
  if (!Number.isFinite(stopChandelierMult) || stopChandelierMult < 0 || stopChandelierMult > 20) {
    return Response.json({ error: "stop_chandelier_mult out of range (0-20)" }, { status: 400 });
  }
  // 三停損模式互斥:同時 >1 個 >0 → 語意含混,擋下
  if ([stopLossPct, stopAtrMult, stopChandelierMult].filter((v) => v > 0).length > 1) {
    return Response.json({
      error: "stop modes mutually exclusive: set only one of stop_loss_pct / stop_atr_mult / stop_chandelier_mult",
    }, { status: 400 });
  }
  // E 工程:進場模型(immediate = 現行為;pullback_ma20 僅 nextopen 下有意義)
  const entryModel =
    body.entry_model === "pullback_ma20" ? "pullback_ma20" : "immediate";
  const entryWaitDays = body.entry_wait_days == null ? 10 : body.entry_wait_days;
  if (!Number.isInteger(entryWaitDays) || entryWaitDays < 1 || entryWaitDays > 40) {
    return Response.json({ error: "entry_wait_days out of range (1-40)" }, { status: 400 });
  }
  if (entryModel === "pullback_ma20" && execModel === "close") {
    return Response.json({ error: "entry_model=pullback_ma20 requires exec_model=nextopen" }, { status: 400 });
  }
  if (execModel === "close" && (stopLossPct > 0 || stopAtrMult > 0 || stopChandelierMult > 0)) {
    return Response.json({ error: "stop_requires_nextopen" }, { status: 400 });
  }

  // 動態 ETF 差別成本(cost_pct 未給時)— 從 app_settings 拿,對齊 holdings 層
  let dynCommRT = 0; // round-trip 手續費 fraction
  let dynTaxStock = 0;
  let dynTaxEtf = 0;
  if (costOverride == null) {
    const { data: cfg, error: cfgError } = await sb
      .from("app_settings")
      .select("key,value")
      .in("key", ["commission_base_rate", "commission_discount", "sell_tax_stock", "sell_tax_etf"]);
    if (cfgError) return Response.json({ error: `cost_settings_error: ${cfgError.message}` }, { status: 500 });
    const cm = new Map((cfg ?? []).map((r) => [r.key as string, Number(r.value)]));
    const base = cm.get("commission_base_rate") ?? 0.001425;
    const disc = cm.get("commission_discount") ?? 1;
    dynCommRT = base * disc * 2;
    dynTaxStock = cm.get("sell_tax_stock") ?? 0.003;
    dynTaxEtf = cm.get("sell_tax_etf") ?? 0.001;
  }
  const feesFor = (symbol: string) => costOverride != null
    ? { buyFee: costOverride / 200, sellFee: costOverride / 200 }
    : { buyFee: dynCommRT / 2, sellFee: dynCommRT / 2 + (isEtf(symbol) ? dynTaxEtf : dynTaxStock) };
  if ([dynCommRT, dynTaxStock, dynTaxEtf].some((value) => !Number.isFinite(value) || value < 0 || value >= 1)) {
    return Response.json({ error: "invalid_cost_settings" }, { status: 500 });
  }

  const params = {
    execution_version: EXECUTION_VERSION,
    accounting_version: ACCOUNTING_VERSION,
    accounting_model: "available_cash_equal_slots_at_window_start",
    initial_capital: INITIAL_CAPITAL,
    quantity_basis: "fractional_adjusted_price_units",
    cost_accounting: "entry_fee_on_buy_notional_exit_fee_on_sell_notional",
    flat_cost_allocation: costOverride == null ? null : "half_buy_half_sell",
    limitations: ["no slippage or market impact model", "fractional adjusted-price units; no lot rounding or minimum commission", "intraday limit fill uses conservative same-bar stop ordering", "missing daily close carries the last known mark and is flagged", "same-session opening sale proceeds can fund opening purchases", "end-of-run open positions are marked before future exit costs"],
    start_date: body.start_date,
    end_date: endDate,
    rebalance_days: rebalanceDays,
    top_n: topN,
    weight_strategy: weightStrategy,
    benchmark_symbol: benchmarkSymbol,
    exec_model: execModel,
    cost_pct: costOverride, // null = 動態 ETF 差別
    cost_model: costOverride == null ? "dynamic_etf_diff" : "flat_override",
    stop_loss_pct: stopLossPct, // M9.4b:0 = 無停損
    stop_atr_mult: stopAtrMult, // L43 A:0 = 不啟用
    stop_chandelier_mult: stopChandelierMult, // L43 B:0 = 不啟用
    entry_model: entryModel, // E:immediate = 現行為
    entry_wait_days: entryModel === "pullback_ma20" ? entryWaitDays : null,
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

  const windows: AllocationWindow[] = [];
  const benchmarkWindows: AllocationWindow[] = [];
  const barsBySymbol = new Map<string, Bar[]>();
  let skippedLimitUp = 0;
  let entryNotFilled = 0;
  let entryLimitNa = 0;

  try {
    for (const [period, pt] of points.entries()) {
      const rankDate = tradeDates[pt.rankIdx];
      const entryExecDate = tradeDates[pt.entryIdx];
      const exitExecDate = tradeDates[pt.exitIdx];
      const { data: ranks, error: rankErr } = await sb
        .rpc("score_universe_at", { as_of_date: rankDate })
        .order("expected_rank", { ascending: true })
        .limit(topN);
      if (rankErr) return await failRun("score_universe_at_error: " + rankErr.message, { rebalance_date: rankDate });
      const rankRows = (ranks as ScoreRow[] | null) ?? [];
      const allSyms = Array.from(new Set([...rankRows.map((r) => r.symbol), benchmarkSymbol]));
      const missingSymbols = allSyms.filter((symbol) => !barsBySymbol.has(symbol));
      // Load through the valuation horizon once per newly encountered symbol.
      // Delayed exits and suspended positions need prices after a rebalance.
      const fetchStart = addDays(tradeDates[Math.max(0, pt.rankIdx - 1)], -45);
      const fetched = await getBarsRange(sb, missingSymbols, fetchStart, endDate);
      for (const symbol of missingSymbols) barsBySymbol.set(symbol, fetched.get(symbol) ?? []);

      function ma20At(arr: Bar[], date: string): number | null {
        const hit = barAtOrBefore(arr, date);
        if (!hit || hit.bar.trade_date !== date || hit.idx < 19) return null;
        const seed = arr.slice(hit.idx - 19, hit.idx + 1);
        return seed.every((b) => b.close > 0)
          ? seed.reduce((sum, b) => sum + b.close, 0) / 20 : null;
      }

      function entryPrice(symbol: string): LedgerFill | null {
        const arr = barsBySymbol.get(symbol) ?? [];
        if (execModel === "close") {
          const hit = barAtOrBefore(arr, rankDate);
          return hit?.bar.trade_date === rankDate
            ? { price: hit.bar.close, date: rankDate, phase: "close" } : null;
        }
        if (entryModel === "pullback_ma20") {
          const limit = ma20At(arr, rankDate);
          if (limit == null) {
            entryLimitNa++;
            return null;
          }
          // Count market sessions, not the number of available rows for a
          // suspended symbol. A missing bar cannot extend an order's lifetime.
          const lastWaitDate = tradeDates[Math.min(pt.entryIdx + entryWaitDays - 1, pt.exitIdx - 1)];
          for (let i = 0; i < arr.length; i++) {
            const b = arr[i];
            if (b.trade_date < entryExecDate) continue;
            if (b.trade_date > lastWaitDate) break;
            if (lockedUp(b, arr[i - 1]?.close ?? null)) continue;
            if (b.open != null && b.open > 0 && b.open <= limit) {
              return { price: b.open, date: b.trade_date, phase: "open" };
            }
            if (b.open != null && b.open > 0 && b.low != null && b.low <= limit) {
              return { price: limit, date: b.trade_date, phase: "intraday" };
            }
          }
          entryNotFilled++;
          return null;
        }
        const hit = barAtOrAfter(arr, entryExecDate);
        if (!hit || hit.bar.trade_date !== entryExecDate) return null;
        if (lockedUp(hit.bar, arr[hit.idx - 1]?.close ?? null)) return null;
        return hit.bar.open != null && hit.bar.open > 0
          ? { price: hit.bar.open, date: entryExecDate, phase: "open" } : null;
      }

      function scheduledExit(symbol: string): LedgerFill | null {
        const arr = barsBySymbol.get(symbol) ?? [];
        if (execModel === "close") {
          const hit = barAtOrBefore(arr, exitExecDate);
          return hit?.bar.trade_date === exitExecDate
            ? { price: hit.bar.close, date: exitExecDate, phase: "close" } : null;
        }
        const hit = barAtOrAfter(arr, exitExecDate);
        const fill = hit ? nextSell(arr, hit.idx) : null;
        return fill ? { ...fill, phase: "open" } : null;
      }

      const orders: LedgerOrder[] = [];
      for (const r of rankRows) {
        const entry = entryPrice(r.symbol);
        if (!entry || entry.price <= 0 || entry.date >= exitExecDate) {
          skippedLimitUp++;
          continue;
        }
        let exit = scheduledExit(r.symbol);
        let stopTriggered = false;
        let pendingExitDate: string | undefined;
        if (stopLossPct > 0 || stopAtrMult > 0 || stopChandelierMult > 0) {
          const exitsAtBoundary = exit?.date === exitExecDate;
          const result = stopExit(barsBySymbol.get(r.symbol) ?? [], entry,
            { date: exitExecDate, price: exitsAtBoundary ? exit!.price : null },
            { pct: stopLossPct, atr: stopAtrMult, chandelier: stopChandelierMult, exitAtOpen: exitsAtBoundary });
          if (result.error && result.error !== "unresolved_exit" && result.error !== "unresolved_limit_down") {
            return await failRun(result.error, { symbol: r.symbol, rebalance_date: rankDate });
          }
          stopTriggered = result.triggered ?? false;
          if (result.fill) {
            // A same-bar stop follows a simulated intraday limit entry.
            const phase = result.fill.date === entry.date && entry.phase === "intraday"
              ? "intraday" : result.phase ?? "open";
            exit = { ...result.fill, phase };
          } else if (result.error === "unresolved_limit_down") {
            exit = null;
          }
          pendingExitDate = result.pendingExitDate;
        }
        orders.push({
          id: period + ":" + r.symbol, symbol: r.symbol,
          rank: Number(r.expected_rank) || null,
          entry, exit, ...feesFor(r.symbol), stopTriggered,
          scheduledExitDate: exitExecDate,
          pendingExitDate: pendingExitDate ?? (exit == null ? exitExecDate : undefined),
        });
      }
      windows.push({ date: entryExecDate, phase: execModel === "close" ? "close" : "open",
        expiresOn: exitExecDate, slots: topN, orders });

      // Gross benchmark uses exactly the same scheduled opening/closing dates.
      // It is independently accounted for, including daily marked drawdown.
      const arrB = barsBySymbol.get(benchmarkSymbol) ?? [];
      const first = barAtOrAfter(arrB, entryExecDate);
      const final = barAtOrAfter(arrB, exitExecDate);
      const be = first?.bar.trade_date === entryExecDate
        ? execModel === "close" ? first.bar.close : first.bar.open : null;
      const bx = final?.bar.trade_date === exitExecDate
        ? execModel === "close" ? final.bar.close : final.bar.open : null;
      if (be == null || bx == null || be <= 0 || bx <= 0) {
        return await failRun("missing_benchmark_price", { entryExecDate, exitExecDate });
      }
      const phase = execModel === "close" ? "close" : "open";
      benchmarkWindows.push({
        date: entryExecDate, phase, expiresOn: exitExecDate, slots: 1,
        orders: [{ id: "benchmark:" + period, symbol: benchmarkSymbol, rank: null,
          entry: { date: entryExecDate, price: be, phase },
          exit: { date: exitExecDate, price: bx, phase }, buyFee: 0, sellFee: 0 }],
      });
    }

    const closes = new Map(Array.from(barsBySymbol, ([symbol, bars]) =>
      [symbol, new Map(bars.map((bar) => [bar.trade_date, bar.close]))]));
    const closeAt = (symbol: string, date: string) => closes.get(symbol)?.get(date) ?? null;
    const ledger = runDailyLedger({ dates: tradeDates, windows, closeAt });
    const benchmark = runDailyLedger({ dates: tradeDates, windows: benchmarkWindows, closeAt });
    const trades: TradeInsert[] = [];
    for (const [account, isBenchmark] of [[ledger, false], [benchmark, true]] as const) {
      for (const trade of account.closed) {
        const order = trade.order;
        trades.push({
          run_id: runId, symbol: order.symbol,
          entry_date: order.entry.date, exit_date: order.exit!.date,
          entry_price: order.entry.price, exit_price: order.exit!.price,
          qty: trade.qty, entry_rank: order.rank, is_benchmark: isBenchmark,
        });
      }
    }
    // Only real completed fills are stored as backtest_trades. Open positions
    // remain explicit in this run's summary and never get fictional exit rows.
    for (let i = 0; i < trades.length; i += 500) {
      const { error } = await sb.from("backtest_trades").insert(trades.slice(i, i + 500));
      if (error) return await failRun("insert_trades_error: " + error.message);
    }

    const normalize = (value: number) => Number((value / INITIAL_CAPITAL).toFixed(8));
    const final = ledger.daily[ledger.daily.length - 1];
    const finalBenchmark = benchmark.daily[benchmark.daily.length - 1];
    const equity = final.equity / INITIAL_CAPITAL;
    const benchmarkEquity = finalBenchmark.equity / INITIAL_CAPITAL;
    const totalReturnPct = (equity - 1) * 100;
    const benchmarkReturnPct = (benchmarkEquity - 1) * 100;
    const sessions = Math.max(1, tradeDates.length - 1);
    const fundedOrders = [...ledger.closed, ...ledger.openPositions].map((position) => position.order);
    const wins = ledger.closed.filter((trade) => trade.netReturn > 0).length;
    const summary = {
      execution_version: EXECUTION_VERSION,
      accounting_version: ACCOUNTING_VERSION,
      max_drawdown_basis: "daily_close_equity",
      sharpe_basis: "daily_close_equity_returns_252_zero_risk_free",
      win_rate_basis: "closed_funded_trades_after_actual_notional_fees",
      win_rate: ledger.closed.length > 0 ? Number((wins / ledger.closed.length * 100).toFixed(2)) : 0,
      total_return_pct: Number(totalReturnPct.toFixed(2)),
      annual_return_pct: Number(((Math.pow(equity, 252 / sessions) - 1) * 100).toFixed(2)),
      max_drawdown_pct: Number(ledger.maxDrawdownPct.toFixed(2)),
      benchmark_max_drawdown_pct: Number(benchmark.maxDrawdownPct.toFixed(2)),
      sharpe: ledger.sharpe == null ? null : Number(ledger.sharpe.toFixed(4)),
      alpha_vs_benchmark: Number((totalReturnPct - benchmarkReturnPct).toFixed(2)),
      benchmark_return_pct: Number(benchmarkReturnPct.toFixed(2)),
      n_trades: ledger.closed.length,
      n_open_positions: ledger.openPositions.length,
      n_rebalances: points.length,
      skipped_limit_up_or_nodata: skippedLimitUp,
      unfunded_orders: ledger.unfundedOrders,
      blocked_by_existing_position: ledger.blockedByExistingPosition,
      delayed_exit_count: fundedOrders.filter((order) => !order.exit || order.exit.date > order.scheduledExitDate!).length,
      stop_loss_triggered_count: fundedOrders.filter((order) => order.stopTriggered).length,
      atr_seed_unavailable: 0,
      entry_model: entryModel,
      entry_not_filled: entryNotFilled,
      entry_limit_na: entryLimitNa,
      exec_model: execModel,
      cost_model: costOverride == null ? "dynamic_etf_diff" : "flat_" + costOverride,
      initial_capital: INITIAL_CAPITAL,
      quantity_basis: "fractional_adjusted_price_units",
      valuation_start_date: tradeDates[0],
      valuation_end_date: tradeDates[tradeDates.length - 1],
      stale_mark_days: ledger.daily.filter((day) => day.stalePositions > 0).length,
      benchmark_stale_mark_days: benchmark.daily.filter((day) => day.stalePositions > 0).length,
      equity_dates: tradeDates,
      equity_curve: ledger.daily.map((day) => normalize(day.equity)),
      benchmark_equity_curve: benchmark.daily.map((day) => normalize(day.equity)),
      cash_curve: ledger.daily.map((day) => normalize(day.cash)),
      reserved_cash_curve: ledger.daily.map((day) => normalize(day.reservedCash)),
      market_value_curve: ledger.daily.map((day) => normalize(day.marketValue)),
      position_count_curve: ledger.daily.map((day) => day.positions),
      stale_position_count_curve: ledger.daily.map((day) => day.stalePositions),
      open_positions: ledger.openPositions.map((position) => ({
        symbol: position.order.symbol,
        entry_date: position.order.entry.date,
        entry_price: position.order.entry.price,
        qty: position.qty,
        invested: position.invested,
        last_price: position.mark,
        last_price_date: position.markDate,
        market_value: position.qty * position.mark,
        scheduled_exit_date: position.order.scheduledExitDate,
        pending_exit_date: position.order.pendingExitDate,
        stop_triggered: position.order.stopTriggered,
      })),
      rebalance_dates: points.map((point) => tradeDates[point.rankIdx]),
    };
    const { error: finishError } = await sb.from("backtest_runs").update({
      status: "finished", finished_at: new Date().toISOString(), summary,
    }).eq("id", runId);
    if (finishError) return await failRun("finish_run_error: " + finishError.message);
    return Response.json({ run_id: runId, status: "finished", summary });
  } catch (error) {
    return await failRun("daily_ledger_error: " + (error instanceof Error ? error.message : String(error)));
  }
});
