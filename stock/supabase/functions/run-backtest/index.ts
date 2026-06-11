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
  // M9.4b:>0 啟用停損(持有期 low 跌破 entry×(1-x/100) 即誠實出場);
  //   0/未給=無停損(stop_loss_pct=0 整段 short-circuit,退版錨點 byte-exact)
  stop_loss_pct?: number;
  // 波動正規化停損(L43,與 stop_loss_pct 三者互斥,多個 >0 → 400):
  //   A. stop_atr_mult>0:進場日 ATR14 算一次,stopLine=entry−k×ATR(全期固定)
  stop_atr_mult?: number;
  //   B. stop_chandelier_mult>0:逐 bar stopLine=max(high,entry..t)−k×ATR14_t(順勢移動鎖利)
  stop_chandelier_mult?: number;
  // 進場模型(E 工程,2026-06-10,「好股等好價」timing 驗證):
  //   'immediate'(預設 = 現行為,nextopen 開盤市價)
  //   'pullback_ma20':限價 = rankDate 的 MA20(EF 內 bars 自算,同 adj 口徑)。
  //     D+1 起 entry_wait_days 個交易日內:open<=limit 用 open 成交(跳空低開),
  //     否則 low<=limit 用 limit 成交(觸價);等嘸/MA20 種子不足 → 該檔本期 skip
  //     (計 entry_not_filled / entry_limit_na,誠實不 fallback)。出場時點不變。
  //   未給/immediate → 整段不執行(退版錨點 byte-exact,L39)
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

// ATR(n):TR=max(H−L,|H−prevC|,|L−prevC|) 的 n 期均(SMA-ATR,確定性)。
// bars sorted-asc。需 endIdx 當根含前 n-1 根 + 各自前一根算 prevClose →
// endIdx >= n。資料不足 / OHLC 缺值 → 回 null(不偽造,L23/L42 精神)。
function atrAt(bars: Bar[], endIdx: number, n: number): number | null {
  if (endIdx < n || endIdx >= bars.length) return null;
  let sum = 0;
  for (let i = endIdx - n + 1; i <= endIdx; i++) {
    const b = bars[i];
    const p = bars[i - 1];
    if (b.high == null || b.low == null || p.close == null) return null;
    sum += Math.max(
      b.high - b.low,
      Math.abs(b.high - p.close),
      Math.abs(b.low - p.close),
    );
  }
  return sum / n;
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
  // M9.4b 停損 %:0/未給 = 無停損(整段 short-circuit,退版錨點 byte-exact)
  const stopLossPct = body.stop_loss_pct == null ? 0 : body.stop_loss_pct;
  // 波動正規化停損(L43):ATR-static / Chandelier,k 倍數;0/未給 = 不啟用
  const stopAtrMult = body.stop_atr_mult == null ? 0 : body.stop_atr_mult;
  const stopChandelierMult =
    body.stop_chandelier_mult == null ? 0 : body.stop_chandelier_mult;
  if (rebalanceDays < 1 || rebalanceDays > 250) {
    return Response.json({ error: "rebalance_days out of range" }, { status: 400 });
  }
  if (topN < 1 || topN > 100) {
    return Response.json({ error: "top_n out of range" }, { status: 400 });
  }
  if (costOverride != null && (costOverride < 0 || costOverride > 5)) {
    return Response.json({ error: "cost_pct out of range (0-5)" }, { status: 400 });
  }
  if (stopLossPct < 0 || stopLossPct > 50) {
    return Response.json({ error: "stop_loss_pct out of range (0-50)" }, { status: 400 });
  }
  if (stopAtrMult < 0 || stopAtrMult > 20) {
    return Response.json({ error: "stop_atr_mult out of range (0-20)" }, { status: 400 });
  }
  if (stopChandelierMult < 0 || stopChandelierMult > 20) {
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
  if (entryWaitDays < 1 || entryWaitDays > 40) {
    return Response.json({ error: "entry_wait_days out of range (1-40)" }, { status: 400 });
  }
  if (entryModel === "pullback_ma20" && execModel === "close") {
    return Response.json({ error: "entry_model=pullback_ma20 requires exec_model=nextopen" }, { status: 400 });
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

  const trades: TradeInsert[] = [];
  const periodReturns: number[] = [];
  let equity = 1.0;
  let benchEquity = 1.0;
  const equityCurve: number[] = [equity];
  const benchEquityCurve: number[] = [benchEquity];
  let skippedLimitUp = 0;
  let stopLossTriggered = 0; // 本 run 因停損提前出場的筆數(三模式共用)
  let atrSeedUnavailable = 0; // L43 透明:ATR 模式但進場 ATR14 資料不足、該持股本期未施停損的筆數
  let entryNotFilled = 0; // E:pullback 等待窗內未觸價 → 本期 skip(機會成本透明計數)
  let entryLimitNa = 0; // E:MA20 種子不足 20 根 → skip(不偽造限價)

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
    // -45(原 -30,L43 時 -10→-30):多備 ~20 交易日給 pullback_ma20 的 MA20 種子(E)。
    // 只擴 fetch 窗,既有 entry/exit/停損皆 date-indexed/date-guarded → byte 不變(L39)。
    const fetchStart = addDays(tradeDates[Math.max(0, pt.rankIdx - 1)], -45);
    const fetchEnd = addDays(tradeDates[Math.min(last, pt.exitIdx + 8)], 2);
    const bars = await getBarsRange(sb, allSyms, fetchStart, fetchEnd);

    // E:rankDate 站位 MA20(含 rankDate 往前 20 根 close 平均;bars 已 adj 同口徑)
    function ma20At(arr: Bar[] | undefined, date: string): number | null {
      const hit = barAtOrBefore(arr, date);
      if (!hit || hit.idx < 19) return null; // 種子不足 20 根
      let sum = 0;
      for (let i = hit.idx - 19; i <= hit.idx; i++) {
        const c = arr![i].close;
        if (c == null || c <= 0) return null;
        sum += c;
      }
      return sum / 20;
    }

    // 取進場價(含鎖死處理)
    function entryPrice(sym: string): { price: number; date: string } | null {
      const arr = bars.get(sym);
      if (execModel === "close") {
        const hit = barAtOrBefore(arr, rankDate);
        return hit ? { price: hit.bar.close, date: hit.bar.trade_date } : null;
      }
      if (entryModel === "pullback_ma20") {
        // 限價單模擬:D+1 起 entry_wait_days 個交易日內等回 MA20。
        // open<=limit → open 成交(跳空低開,限價單以開盤價成交);
        // 否則 low<=limit → limit 成交(盤中觸價)。等嘸/種子不足 → skip(誠實)。
        // 鎖漲停日 low=open>limit 自然不成交;接刀風險不另擋(正是要量化的)。
        const limit = ma20At(arr, rankDate);
        if (limit == null) {
          entryLimitNa++;
          return null;
        }
        const start = barAtOrAfter(arr, entryExecDate);
        if (!start) return null;
        const lastIdx = Math.min(start.idx + entryWaitDays - 1, arr!.length - 1);
        for (let i = start.idx; i <= lastIdx; i++) {
          const b = arr![i];
          if (b.trade_date >= exitExecDate) break; // 至少持有到出場日前
          if (b.open != null && b.open <= limit) {
            return { price: b.open, date: b.trade_date };
          }
          if (b.low != null && b.low <= limit) {
            return { price: limit, date: b.trade_date };
          }
        }
        entryNotFilled++;
        return null;
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
      let x = exitPrice(r.symbol);
      if (!e || !x || e.price <= 0) {
        if (!e) skippedLimitUp++; // 含買不到(鎖漲停/無資料)
        continue;
      }
      // 停損(三互斥模式;持有期 (e.date, x.date] 首根 low 跌破 stopLine → 誠實出場)。
      //   三者全 0 → 整段不執行(退版錨點 byte-exact 鐵律,L39)。
      //   stopLossPct>0 路徑與舊版逐 bar/觸發/誠實出場完全等價(byte-exact)。
      if (stopLossPct > 0 || stopAtrMult > 0 || stopChandelierMult > 0) {
        const arr = bars.get(r.symbol);
        if (arr) {
          const eIdx = arr.findIndex((b) => b.trade_date === e.date);
          // A/B 進場日 ATR14(資料不足 → null,不偽造)
          const atrEntry =
            (stopAtrMult > 0 || stopChandelierMult > 0) && eIdx >= 0
              ? atrAt(arr, eIdx, 14)
              : null;
          if (
            (stopAtrMult > 0 || stopChandelierMult > 0) && eIdx >= 0 &&
            atrEntry == null
          ) {
            atrSeedUnavailable++; // 該持股本期 ATR 種子不足 → 不施停損(透明計數)
          }
          // 固定 %(保留舊行為)/ A ATR-static(進場算一次全期固定)
          const fixedStopLine =
            stopLossPct > 0 ? e.price * (1 - stopLossPct / 100) : null;
          const atrStopLine =
            stopAtrMult > 0 && atrEntry != null
              ? e.price - stopAtrMult * atrEntry
              : null;
          // B Chandelier 滾動最高(含進場日 high 起算)
          let runHigh =
            stopChandelierMult > 0 && eIdx >= 0 && arr[eIdx].high != null
              ? (arr[eIdx].high as number)
              : -Infinity;
          for (let i = eIdx >= 0 ? eIdx + 1 : 0; i < arr.length; i++) {
            const b = arr[i];
            if (b.trade_date <= e.date) continue; // 進場日當天不算(成交後才建倉)
            if (b.trade_date > x.date) break; // 超過正常出場 → 不觸發
            let stopLine: number | null = null;
            if (fixedStopLine != null) {
              stopLine = fixedStopLine;
            } else if (atrStopLine != null) {
              stopLine = atrStopLine;
            } else if (stopChandelierMult > 0) {
              if (b.high != null && b.high > runHigh) runHigh = b.high;
              const atrT = atrAt(arr, i, 14);
              if (atrT != null && runHigh > -Infinity) {
                stopLine = runHigh - stopChandelierMult * atrT;
              }
            }
            if (stopLine == null) continue; // 資料不足這根跳過(下一根可能就夠)
            if (b.low != null && b.low <= stopLine) {
              // 誠實出場價:跳空開盤已 ≤ 停損線 → 用 open(可能比停損線更糟);
              //   盤中才跌破 → 用停損線價(觸價單假設)。一字鎖跌停亦走 open(認最差)
              const stopExit =
                b.open != null && b.open <= stopLine ? b.open : stopLine;
              x = { price: stopExit, date: b.trade_date };
              stopLossTriggered++;
              break;
            }
          }
        }
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
    stop_loss_triggered_count: stopLossTriggered,
    atr_seed_unavailable: atrSeedUnavailable,
    // E:pullback 機會成本透明計數(皆已含在 skipped_limit_up_or_nodata 總數內)
    entry_model: entryModel,
    entry_not_filled: entryNotFilled,
    entry_limit_na: entryLimitNa,
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
