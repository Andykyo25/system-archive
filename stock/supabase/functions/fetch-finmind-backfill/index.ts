// FinMind 歷史回填(手動 trigger,不接 cron)
//
// 用法:
//   curl -X POST '<host>/functions/v1/fetch-finmind-backfill' \
//     -H 'Authorization: Bearer <service_role_jwt>' \
//     -H 'Content-Type: application/json' \
//     -d '{"dataset":"price","start_date":"2023-01-01","end_date":"2023-06-30","symbols":["2330","2317"]}'
//
// 支援的 dataset:
//   price          → price_daily (TaiwanStockPrice)
//   institutional  → stock_institutional
//   margin         → stock_margin
//   monthly_revenue→ stock_monthly_revenue
//   fundamentals   → stock_fundamentals_quarterly (3 個 dataset 合一)
//   shareholding   → stock_shareholding
//   lending        → stock_securities_lending
//   valuation      → stock_pe_pb_daily
//   corporate_action → stock_corporate_action (split + dividend,2 call/symbol)
//
// 參數:
//   dataset: 上面的鍵
//   start_date / end_date: ISO 日期
//   symbols(optional): 不給就用所有 targetSymbols(holdings ∪ watchlist ∪ industry ∪ universe ∪ etf)
//   symbol_offset / symbol_limit(optional): 分頁,避免 quota 一次爆掉
//
// quota:每次 run 會 deduct quota。Andy 觀察用量看跑幾天才能跑完
//
// 預期分批:
//   200 symbol × 1 dataset = 200 API call
//   quota 600/day → 一天可跑 3 個 dataset OR 一個 dataset 跑 200 symbol
//   3 年資料 → fundamentals 取 12 季 ≈ 沒問題;price 取 ~750 trade days → 大,單檔 1 個 call 沒問題
//   所以 200 檔 price 一天能跑完;institutional/margin 也是各一天

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const FINMIND_DAILY_BUDGET = 600;

interface ReqBody {
  dataset: string;
  start_date: string;
  end_date?: string;
  symbols?: string[];
  symbol_offset?: number;
  symbol_limit?: number;
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

// Generic helper to call FinMind for a (dataset, symbol) range
async function callFinmind(
  token: string,
  finmindDataset: string,
  dataId: string,
  startDate: string,
  endDate: string,
  // deno-lint-ignore no-explicit-any
): Promise<any[]> {
  const u = new URL(FINMIND_URL);
  u.searchParams.set("dataset", finmindDataset);
  u.searchParams.set("data_id", dataId);
  u.searchParams.set("start_date", startDate);
  u.searchParams.set("end_date", endDate);
  u.searchParams.set("token", token);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.status !== 200) throw new Error(`FinMind status=${j.status} msg=${j.msg}`);
  return Array.isArray(j.data) ? j.data : [];
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return Response.json({ error: "missing bearer" }, { status: 401 });
  let role: unknown;
  try { role = decodeJwtPayload(auth.slice(7)).role; }
  catch { return Response.json({ error: "invalid jwt" }, { status: 401 }); }
  if (role !== "service_role") return Response.json({ error: "forbidden", role }, { status: 403 });

  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SERVICE_ROLE) return Response.json({ error: "missing SUPABASE_SERVICE_ROLE_KEY env" }, { status: 500 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);

  let body: ReqBody;
  try { body = await req.json(); }
  catch { return Response.json({ error: "invalid json body" }, { status: 400 }); }
  if (!body.dataset) return Response.json({ error: "missing dataset" }, { status: 400 });
  if (!body.start_date) return Response.json({ error: "missing start_date" }, { status: 400 });
  const endDate = body.end_date ?? new Date().toISOString().slice(0, 10);

  const tokenRes = await supabase.rpc("read_finmind_token");
  if (tokenRes.error || !tokenRes.data) {
    return Response.json({ error: "missing finmind_token in vault" }, { status: 500 });
  }
  const TOKEN = tokenRes.data as string;

  // resolve target symbols
  let allSymbols: string[];
  if (body.symbols && body.symbols.length > 0) {
    allSymbols = body.symbols;
  } else {
    const [holdingsCurrent, watchlist, industry, universe, etf] = await Promise.all([
      supabase.from("v_holdings_current").select("symbol"),
      supabase.from("watchlist").select("symbol"),
      supabase.from("industry_stocks").select("symbol"),
      supabase.from("stock_universe").select("symbol"),
      supabase.from("etf_metadata").select("symbol"),
    ]);
    const set = new Set<string>();
    if (holdingsCurrent.error) {
      const { data: oldHoldings } = await supabase.from("holdings").select("symbol").is("closed_at", null);
      for (const r of oldHoldings ?? []) set.add(r.symbol);
    } else {
      for (const r of holdingsCurrent.data ?? []) set.add(r.symbol);
    }
    for (const r of watchlist.data ?? []) set.add(r.symbol);
    for (const r of industry.data ?? []) set.add(r.symbol);
    for (const r of universe.data ?? []) set.add(r.symbol);
    for (const r of etf.data ?? []) set.add(r.symbol);
    allSymbols = Array.from(set);
  }

  const offset = body.symbol_offset ?? 0;
  const limit = body.symbol_limit ?? allSymbols.length;
  const symbols = allSymbols.slice(offset, offset + limit);

  if (symbols.length === 0) return Response.json({ skipped: "no_symbols" });

  // quota
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from("api_quota_state").upsert(
    { source: "finmind", quota_date: today, used: 0, budget: FINMIND_DAILY_BUDGET },
    { onConflict: "source,quota_date", ignoreDuplicates: true },
  );
  const { data: quotaRow } = await supabase
    .from("api_quota_state").select("used, budget")
    .eq("source", "finmind").eq("quota_date", today).single();
  const usedSoFar = quotaRow?.used ?? 0;
  const budget = quotaRow?.budget ?? FINMIND_DAILY_BUDGET;
  const remaining = budget - usedSoFar;
  if (remaining < 1) {
    return Response.json({ skipped: "quota_exhausted", quota: { used: usedSoFar, budget } });
  }

  const { data: logRow } = await supabase
    .from("fetch_log").insert({ source: `backfill_${body.dataset}` }).select("id").single();
  const logId = logRow!.id;

  let written = 0;
  let apiCalls = 0;
  const errors: string[] = [];

  // dataset 對應到 FinMind dataset 名稱 + 寫入策略
  // 每個 dataset 各自的「per-symbol API call count」
  let callsPerSymbol = 1;
  if (body.dataset === "fundamentals") callsPerSymbol = 3;
  if (body.dataset === "corporate_action") callsPerSymbol = 2;

  for (const symbol of symbols) {
    if (apiCalls + callsPerSymbol > remaining) {
      errors.push(`quota exhausted at ${symbol} (need ${callsPerSymbol}, have ${remaining - apiCalls})`);
      break;
    }
    try {
      if (body.dataset === "price") {
        apiCalls++;
        const data = await callFinmind(TOKEN, "TaiwanStockPrice", symbol, body.start_date, endDate);
        // deno-lint-ignore no-explicit-any
        const rows = (data as any[]).flatMap((r) => {
          const close = toN(r.close);
          if (close == null) return [];
          return [{
            symbol: String(r.stock_id),
            trade_date: String(r.date),
            open: toN(r.open),
            high: toN(r.max),   // FinMind 用 max/min
            low: toN(r.min),
            close,
            volume: toN(r.Trading_Volume),
            source: "finmind",
            is_provisional: true,
          }];
        });
        if (rows.length > 0) {
          const { data: dd, error } = await supabase
            .from("price_daily")
            .upsert(rows, { onConflict: "symbol,trade_date", ignoreDuplicates: true })
            .select("symbol");
          if (error) throw error;
          written += dd?.length ?? 0;
        }
      } else if (body.dataset === "institutional") {
        apiCalls++;
        const data = await callFinmind(TOKEN, "TaiwanStockInstitutionalInvestorsBuySell", symbol, body.start_date, endDate);
        // pivot
        const pivot = new Map<string, Record<string, number>>();
        for (const r of data) {
          const key = `${r.stock_id}|${r.date}`;
          if (!pivot.has(key)) pivot.set(key, {
            foreign_buy: 0, foreign_sell: 0, invest_trust_buy: 0, invest_trust_sell: 0,
            dealer_self_buy: 0, dealer_self_sell: 0, dealer_hedging_buy: 0, dealer_hedging_sell: 0,
          });
          const slot = pivot.get(key)!;
          const buy = Number(r.buy) || 0;
          const sell = Number(r.sell) || 0;
          const nm = String(r.name);
          if (nm === "Foreign_Investor" || nm === "Foreign_Dealer_Self") {
            slot.foreign_buy += buy; slot.foreign_sell += sell;
          } else if (nm === "Investment_Trust") {
            slot.invest_trust_buy += buy; slot.invest_trust_sell += sell;
          } else if (nm === "Dealer_self") {
            slot.dealer_self_buy += buy; slot.dealer_self_sell += sell;
          } else if (nm === "Dealer_Hedging") {
            slot.dealer_hedging_buy += buy; slot.dealer_hedging_sell += sell;
          }
        }
        const rows = Array.from(pivot.entries()).map(([key, p]) => {
          const [stockId, date] = key.split("|");
          const fn = p.foreign_buy - p.foreign_sell;
          const itn = p.invest_trust_buy - p.invest_trust_sell;
          const dsn = p.dealer_self_buy - p.dealer_self_sell;
          const dhn = p.dealer_hedging_buy - p.dealer_hedging_sell;
          return {
            symbol: stockId,
            trade_date: date,
            foreign_buy: p.foreign_buy, foreign_sell: p.foreign_sell, foreign_net: fn,
            invest_trust_buy: p.invest_trust_buy, invest_trust_sell: p.invest_trust_sell, invest_trust_net: itn,
            dealer_self_buy: p.dealer_self_buy, dealer_self_sell: p.dealer_self_sell, dealer_self_net: dsn,
            dealer_hedging_buy: p.dealer_hedging_buy, dealer_hedging_sell: p.dealer_hedging_sell, dealer_hedging_net: dhn,
            three_major_net: fn + itn + dsn + dhn,
          };
        });
        if (rows.length > 0) {
          const { error } = await supabase
            .from("stock_institutional")
            .upsert(rows, { onConflict: "symbol,trade_date", ignoreDuplicates: true });
          if (error) throw error;
          written += rows.length;
        }
      } else if (body.dataset === "margin") {
        apiCalls++;
        const data = await callFinmind(TOKEN, "TaiwanStockMarginPurchaseShortSale", symbol, body.start_date, endDate);
        // deno-lint-ignore no-explicit-any
        const rows = (data as any[]).map((r) => {
          const mb = Number(r.MarginPurchaseTodayBalance) || 0;
          const mp = Number(r.MarginPurchaseYesterdayBalance) || 0;
          const sb = Number(r.ShortSaleTodayBalance) || 0;
          const sp = Number(r.ShortSaleYesterdayBalance) || 0;
          return {
            symbol: String(r.stock_id), trade_date: String(r.date),
            margin_buy: Number(r.MarginPurchaseBuy) || 0,
            margin_sell: Number(r.MarginPurchaseSell) || 0,
            margin_cash_repay: Number(r.MarginPurchaseCashRepayment) || 0,
            margin_balance: mb, margin_balance_prev: mp, margin_delta: mb - mp,
            margin_limit: Number(r.MarginPurchaseLimit) || 0,
            short_sell: Number(r.ShortSaleSell) || 0,
            short_buy: Number(r.ShortSaleBuy) || 0,
            short_cash_repay: Number(r.ShortSaleCashRepayment) || 0,
            short_balance: sb, short_balance_prev: sp, short_delta: sb - sp,
            short_limit: Number(r.ShortSaleLimit) || 0,
            offset_loan_and_short: Number(r.OffsetLoanAndShort) || 0,
          };
        });
        if (rows.length > 0) {
          const { error } = await supabase
            .from("stock_margin")
            .upsert(rows, { onConflict: "symbol,trade_date", ignoreDuplicates: true });
          if (error) throw error;
          written += rows.length;
        }
      } else if (body.dataset === "monthly_revenue") {
        apiCalls++;
        const data = await callFinmind(TOKEN, "TaiwanStockMonthRevenue", symbol, body.start_date, endDate);
        // deno-lint-ignore no-explicit-any
        const rows = (data as any[]).flatMap((r) => {
          const rev = Number(r.revenue);
          const y = parseInt(String(r.revenue_year), 10);
          const m = parseInt(String(r.revenue_month), 10);
          if (!Number.isFinite(rev) || !Number.isFinite(y) || !Number.isFinite(m)) return [];
          return [{ symbol: String(r.stock_id), period_year: y, period_month: m, revenue: rev }];
        });
        if (rows.length > 0) {
          const { error } = await supabase
            .from("stock_monthly_revenue")
            .upsert(rows, { onConflict: "symbol,period_year,period_month", ignoreDuplicates: true });
          if (error) throw error;
          written += rows.length;
        }
      } else if (body.dataset === "valuation") {
        apiCalls++;
        const data = await callFinmind(TOKEN, "TaiwanStockPER", symbol, body.start_date, endDate);
        // deno-lint-ignore no-explicit-any
        const rows = (data as any[]).map((r) => ({
          symbol: String(r.stock_id),
          trade_date: String(r.date),
          pe: toN(r.PER),
          pb: toN(r.PBR),
          dividend_yield: toN(r.dividend_yield),
        }));
        if (rows.length > 0) {
          const { error } = await supabase
            .from("stock_pe_pb_daily")
            .upsert(rows, { onConflict: "symbol,trade_date", ignoreDuplicates: true });
          if (error) throw error;
          written += rows.length;
        }
      } else if (body.dataset === "fundamentals") {
        // 3 個 dataset
        apiCalls += 3;
        const [fs, bs, cf] = await Promise.all([
          callFinmind(TOKEN, "TaiwanStockFinancialStatements", symbol, body.start_date, endDate),
          callFinmind(TOKEN, "TaiwanStockBalanceSheet", symbol, body.start_date, endDate),
          callFinmind(TOKEN, "TaiwanStockCashFlowsStatement", symbol, body.start_date, endDate),
        ]);
        const pivot = (rows: { date: string; type: string; value: unknown }[]) => {
          const m = new Map<string, Map<string, number>>();
          for (const r of rows) {
            if (!m.has(r.date)) m.set(r.date, new Map());
            const v = Number(r.value);
            if (Number.isFinite(v)) m.get(r.date)!.set(r.type, v);
          }
          return m;
        };
        // deno-lint-ignore no-explicit-any
        const fsMap = pivot(fs as any[]);
        // deno-lint-ignore no-explicit-any
        const bsMap = pivot(bs as any[]);
        // deno-lint-ignore no-explicit-any
        const cfMap = pivot(cf as any[]);
        const allPeriods = new Set([...fsMap.keys(), ...bsMap.keys(), ...cfMap.keys()]);
        const rows = [];
        for (const period of allPeriods) {
          const f = fsMap.get(period);
          const b = bsMap.get(period);
          const c = cfMap.get(period);
          const ocf = c?.get("CashFlowsFromOperatingActivities") ?? null;
          const ic = c?.get("CashProvidedByInvestingActivities") ?? null;
          const fcf = (ocf != null && ic != null) ? ocf + ic : null;
          rows.push({
            symbol, period_end: period,
            eps: f?.get("EPS") ?? null,
            net_income: f?.get("EquityAttributableToOwnersOfParent") ?? null,
            revenue: f?.get("Revenue") ?? null,
            gross_profit: f?.get("GrossProfit") ?? null,
            operating_income: f?.get("OperatingIncome") ?? null,
            total_equity: b?.get("EquityAttributableToOwnersOfParent") ?? null,
            total_assets: b?.get("TotalAssets") ?? null,
            total_liabilities: b?.get("Liabilities") ?? null,
            ocf, ic, fcf,
          });
        }
        if (rows.length > 0) {
          const { error } = await supabase
            .from("stock_fundamentals_quarterly")
            .upsert(rows, { onConflict: "symbol,period_end", ignoreDuplicates: true });
          if (error) throw error;
          written += rows.length;
        }
      } else if (body.dataset === "shareholding") {
        apiCalls++;
        const data = await callFinmind(TOKEN, "TaiwanStockShareholding", symbol, body.start_date, endDate);
        // deno-lint-ignore no-explicit-any
        const rows = (data as any[]).map((r) => ({
          symbol: String(r.stock_id),
          report_date: String(r.date),
          foreign_remaining_shares: toN(r.ForeignInvestmentRemainingShares),
          foreign_used_shares: toN(r.ForeignInvestmentShares),
          foreign_remain_ratio: toN(r.ForeignInvestmentRemainRatio),
          foreign_holding_ratio: toN(r.ForeignInvestmentSharesRatio),
          foreign_upper_limit_ratio: toN(r.ForeignInvestmentUpperLimitRatio),
          chinese_upper_limit_ratio: toN(r.ChineseInvestmentUpperLimitRatio),
          shares_issued: toN(r.NumberOfSharesIssued),
          recently_declared_date: r.RecentlyDeclareDate ? String(r.RecentlyDeclareDate) : null,
        }));
        if (rows.length > 0) {
          const { error } = await supabase
            .from("stock_shareholding")
            .upsert(rows, { onConflict: "symbol,report_date", ignoreDuplicates: true });
          if (error) throw error;
          written += rows.length;
        }
      } else if (body.dataset === "lending") {
        apiCalls++;
        const data = await callFinmind(TOKEN, "TaiwanStockSecuritiesLending", symbol, body.start_date, endDate);
        // deno-lint-ignore no-explicit-any
        const rows = (data as any[]).map((r) => ({
          symbol: String(r.stock_id),
          trade_date: String(r.date),
          transaction_type: r.transaction_type ? String(r.transaction_type) : null,
          volume: toN(r.volume),
          fee_rate: toN(r.fee_rate),
          close_price: toN(r.close),
          original_return_date: r.original_return_date ? String(r.original_return_date) : null,
          original_lending_period: toN(r.original_lending_period),
        }));
        if (rows.length > 0) {
          const { error } = await supabase
            .from("stock_securities_lending")
            .upsert(rows, {
              onConflict: "symbol,trade_date,transaction_type,volume,fee_rate",
              ignoreDuplicates: true,
            });
          if (error) throw error;
          written += rows.length;
        }
      } else if (body.dataset === "corporate_action") {
        // 還原權值來源:TaiwanStockSplitPrice(分割) + TaiwanStockDividendResult(除權息)
        // 兩表免費、欄位一致:date / stock_id / before_price / after_price
        // ratio = after_price / before_price(該 action 日當天調整係數,< 1)
        apiCalls += 2;
        const [splits, divs] = await Promise.all([
          callFinmind(TOKEN, "TaiwanStockSplitPrice", symbol, body.start_date, endDate),
          callFinmind(TOKEN, "TaiwanStockDividendResult", symbol, body.start_date, endDate),
        ]);
        const caRows: Array<{
          symbol: string; action_date: string; action_type: string;
          before_price: number; after_price: number; ratio: number;
        }> = [];
        const pushCA = (
          // deno-lint-ignore no-explicit-any
          arr: any[],
          actionType: "split" | "dividend",
        ) => {
          for (const r of arr) {
            const bp = toN(r.before_price);
            const ap = toN(r.after_price);
            if (bp == null || ap == null || bp === 0) continue;
            caRows.push({
              symbol: String(r.stock_id),
              action_date: String(r.date),
              action_type: actionType,
              before_price: bp,
              after_price: ap,
              ratio: ap / bp,
            });
          }
        };
        // deno-lint-ignore no-explicit-any
        pushCA(splits as any[], "split");
        // deno-lint-ignore no-explicit-any
        pushCA(divs as any[], "dividend");
        if (caRows.length > 0) {
          const { error } = await supabase
            .from("stock_corporate_action")
            .upsert(caRows, {
              onConflict: "symbol,action_date,action_type",
              ignoreDuplicates: true,
            });
          if (error) throw error;
          written += caRows.length;
        }
      } else {
        throw new Error(`unknown dataset ${body.dataset}`);
      }
    } catch (e) {
      errors.push(`${symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await supabase.from("api_quota_state")
    .update({ used: usedSoFar + apiCalls })
    .eq("source", "finmind").eq("quota_date", today);

  await supabase.from("fetch_log").update({
    finished_at: new Date().toISOString(),
    success: errors.length === 0,
    rows_written: written,
    error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null,
  }).eq("id", logId);

  return Response.json({
    dataset: body.dataset,
    range: { start: body.start_date, end: endDate },
    target_symbols_in_batch: symbols.length,
    api_calls: apiCalls,
    written,
    errors: errors.length,
    quota: { used: usedSoFar + apiCalls, budget },
    next_offset_hint: offset + limit,
  });
});
