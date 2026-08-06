"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

// 從 app_settings 拉 fee/tax 設定
// (commission_discount × commission_base_rate = 實際 fee rate)
async function loadFeeSettings(): Promise<{
  feeRate: number;
  taxStock: number;
  taxEtf: number;
}> {
  const sb = createClient();
  const { data, error } = await sb
    .from("app_settings")
    .select("key, value")
    .in("key", [
      "commission_discount",
      "commission_base_rate",
      "sell_tax_stock",
      "sell_tax_etf",
    ]);
  if (error) throw new Error(`讀取費率設定失敗:${error.message}`);
  const rows = (data ?? []) as { key: string; value: number | string }[];
  const map = new Map<string, number>(
    rows.map((r) => [r.key, Number(r.value)]),
  );
  const discount = map.get("commission_discount") ?? 1;
  const base = map.get("commission_base_rate") ?? 0.001425;
  return {
    feeRate: discount * base,
    taxStock: map.get("sell_tax_stock") ?? 0.003,
    taxEtf: map.get("sell_tax_etf") ?? 0.001,
  };
}

function isEtfSymbol(symbol: string): boolean {
  // 台股 ETF 一律以 '00' 開頭(0050、0056、00878、006208、00679B…)
  return /^00\d+/.test(symbol);
}

// 計算手續費(雙邊都收)
// 券商實際慣例:**無條件捨去到整數元**(floor),不是四捨五入。
// 對照 Andy 對帳單:14000×12.97×0.001425=258.83 → 258 / 1000×225×0.001425=320.625 → 320
// 台股手續費下限 20(慣例),為與既有 app_settings 邏輯一致暫不套下限
function calcFee(qty: number, price: number, feeRate: number): number {
  return Math.floor(qty * price * feeRate);
}

// 計算證交稅(只賣出收,個股 0.3% / ETF 0.1%)
// 同樣 floor 到整數元(181580×0.001=181.58 → 181)
function calcTax(qty: number, price: number, taxRate: number): number {
  return Math.floor(qty * price * taxRate);
}

// 新增 BUY transaction(取代原本的 addHolding)
export async function addBuyTransaction(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  const qty = Number(formData.get("qty"));
  const price = Number(formData.get("price"));
  const txnDateRaw = String(formData.get("txn_date") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!symbol) throw new Error("股號必填");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("股數必須是正整數");
  if (!Number.isFinite(price) || price <= 0) throw new Error("價格必須是正數");

  const { feeRate } = await loadFeeSettings();
  const fee = calcFee(qty, price, feeRate);
  const txnDate = txnDateRaw || new Date().toISOString().slice(0, 10);

  const sb = createClient();
  const { error } = await sb.from("holdings_transactions").insert({
    symbol,
    txn_type: "BUY",
    qty,
    price,
    fee,
    tax: 0,
    txn_date: txnDate,
    note,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/holdings");
  revalidatePath("/");
}

// 新增 SELL transaction(從持股表「賣出」按鈕來)
export async function addSellTransaction(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  const qty = Number(formData.get("qty"));
  const price = Number(formData.get("price"));
  const txnDateRaw = String(formData.get("txn_date") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!symbol) throw new Error("股號必填");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("股數必須是正整數");
  if (!Number.isFinite(price) || price <= 0) throw new Error("價格必須是正數");

  // 驗證 net_qty 足夠
  const sb = createClient();
  const { data: current, error: currentErr } = await sb
    .from("v_holdings_current")
    .select("net_qty")
    .eq("symbol", symbol)
    .maybeSingle();
  if (currentErr) throw new Error(`讀取目前持股失敗:${currentErr.message}`);
  if (!current) throw new Error(`沒有持有 ${symbol}`);
  const netQty = Number(current.net_qty);
  if (qty > netQty) {
    throw new Error(`賣出股數 ${qty} 超過目前持有 ${netQty}`);
  }

  const { feeRate, taxStock, taxEtf } = await loadFeeSettings();
  const fee = calcFee(qty, price, feeRate);
  const taxRate = isEtfSymbol(symbol) ? taxEtf : taxStock;
  const tax = calcTax(qty, price, taxRate);
  const txnDate = txnDateRaw || new Date().toISOString().slice(0, 10);

  const { error } = await sb.from("holdings_transactions").insert({
    symbol,
    txn_type: "SELL",
    qty,
    price,
    fee,
    tax,
    txn_date: txnDate,
    note,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/holdings");
  revalidatePath("/");
}

// 買入前脈絡檢查(A 工程 2026-07-03):追高/回追/盲區警示,不擋單只強制看見。
// 動機:7/01-7/02 兩筆虧損 = 追高區回追(2408)+ 追蹤池外盲區單(3236),
// 資訊當時都存在(v_entry_quality 亮追高)但不在下單路徑上。
export interface BuyContext {
  symbol: string;
  covered: boolean; // false = 不在 v_entry_quality(追蹤池外,系統盲區)
  zone: "chase" | "neutral" | "pullback" | "broken" | "unknown" | null;
  devMa20: number | null;
  ret20d: number | null;
  offHigh: number | null;
  currentPrice: number | null;
  // 近 10 日曆天內同檔 SELL(供回追判斷:現價 > 賣價 = 賣飛回追)
  recentSell: { date: string; price: number } | null;
  // 歷史戰績(波段平倉,v_trade_behavior)
  chaseWins: number;
  chaseLosses: number;
  reentryWins: number;
  reentryLosses: number;
  sizing: BuySizing | null; // 資料不足(<15 bars / 無本金設定)= null,不偽造
  // regime 條件化(規畫④A 2026-07-11):此刻 0050 近 61 筆還原報酬%(同 dashboard 口徑)
  regimeRet: number | null;
  // 你的追高買勝/敗發生時的 regime 區間 [min, max](v_trade_behavior v3 動態聚合,永不 stale)
  chaseWinRegimeBand: [number, number] | null;
  chaseLossRegimeBand: [number, number] | null;
  // 未來 14 天內事件(法說會/除權息/股東會,stock_events)
  upcomingEvents: { type: string; date: string }[];
}

// ATR 部位管理(拍板規畫② 2026-07-10):建議張數 = 風險預算 ÷ (k×ATR14×1000)。
// ATR14 = 近 14 日 True Range 簡單平均(raw 價;近期無除權息時與還原價等價)。
// capital = 初始本金 + 已實現(含當沖)+ 未實現 — 單一本金假設,同權益曲線 caveat。
// 只做呈現不擋單;不動因子/排名/回測(免 OOS 閘,L36 範圍外)。
export interface BuySizing {
  atr14: number; // NT$
  atrPct: number; // ATR14 / 現價 %(現價缺時用最近收盤)
  kMultiple: number; // app_settings.atr_stop_multiple
  stopDistance: number; // k × ATR14(NT$)
  riskPct: number; // app_settings.risk_pct_per_trade
  capital: number; // NT$
  riskBudget: number; // capital × riskPct
  lotRisk: number; // stopDistance × 1000 = 買 1 張的停損風險
  suggestedLots: number; // floor(riskBudget / lotRisk)
  lotValue: number | null; // 1 張市值(現價 × 1000)
  existingValue: number; // 該檔現有持股市值
  portfolioValue: number; // 全部持股市值
}

function n(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

export async function checkBuyContext(symbol: string): Promise<BuyContext | null> {
  const s = symbol.trim();
  if (!/^[0-9A-Za-z]{4,6}$/.test(s)) return null;
  const sb = createClient();
  const since = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const eventHorizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const [eq, pf, rt, sells, behavior, bars, sizingSettings, summary, pnl, regimeBars, events] = await Promise.all([
    sb
      .from("v_entry_quality")
      .select("entry_zone, dev_ma20_pct, off_high_pct")
      .eq("symbol", s)
      .maybeSingle(),
    sb.from("v_price_factors").select("ret_20d_pct").eq("symbol", s).maybeSingle(),
    sb
      .from("v_latest_price_realtime")
      .select("current_price")
      .eq("symbol", s)
      .maybeSingle(),
    sb
      .from("holdings_transactions")
      .select("txn_date, price")
      .eq("symbol", s)
      .eq("txn_type", "SELL")
      .gte("txn_date", since)
      .order("txn_date", { ascending: false })
      .limit(1),
    sb
      .from("v_trade_behavior")
      .select("is_win, is_chase_buy, is_reentry_buy, regime_60d_at_entry"),
    sb
      .from("price_daily")
      .select("high, low, close")
      .eq("symbol", s)
      .gt("close", 0)
      .order("trade_date", { ascending: false })
      .limit(15),
    sb
      .from("app_settings")
      .select("key, value")
      .in("key", ["initial_capital", "risk_pct_per_trade", "atr_stop_multiple"]),
    sb
      .from("v_holdings_summary")
      .select("total_realized_pnl, total_unrealized_pnl")
      .single(),
    sb.from("v_holdings_pnl").select("symbol, market_value"),
    sb
      .from("price_daily")
      .select("close, adj_factor")
      .eq("symbol", "0050")
      .gt("close", 0)
      .order("trade_date", { ascending: false })
      .limit(61),
    sb
      .from("stock_events")
      .select("event_type, event_date")
      .eq("symbol", s)
      .gte("event_date", today)
      .lte("event_date", eventHorizon)
      .order("event_date", { ascending: true }),
  ]);

  let chaseWins = 0,
    chaseLosses = 0,
    reentryWins = 0,
    reentryLosses = 0;
  const chaseWinRegimes: number[] = [];
  const chaseLossRegimes: number[] = [];
  for (const r of (behavior.data as
    | {
        is_win: boolean;
        is_chase_buy: boolean | null;
        is_reentry_buy: boolean;
        regime_60d_at_entry: number | string | null;
      }[]
    | null) ?? []) {
    if (r.is_chase_buy === true) {
      r.is_win ? chaseWins++ : chaseLosses++;
      const reg = n(r.regime_60d_at_entry);
      if (reg != null) (r.is_win ? chaseWinRegimes : chaseLossRegimes).push(reg);
    }
    if (r.is_reentry_buy) r.is_win ? reentryWins++ : reentryLosses++;
  }
  const band = (xs: number[]): [number, number] | null =>
    xs.length > 0 ? [Math.min(...xs), Math.max(...xs)] : null;

  // 此刻 regime(0050 近 61 筆還原報酬,同 dashboard getCachedRegime 口徑)
  let regimeRet: number | null = null;
  {
    const rows = (regimeBars.data as
      | { close: number | string; adj_factor: number | string | null }[]
      | null) ?? [];
    if (rows.length === 61) {
      const adj = (r: (typeof rows)[number]) =>
        Number(r.close) * Number(r.adj_factor ?? 1);
      const last = adj(rows[0]);
      const base = adj(rows[60]);
      if (base > 0) regimeRet = (last / base - 1) * 100;
    }
  }

  const eqRow = eq.data as
    | { entry_zone: BuyContext["zone"]; dev_ma20_pct: number | string | null; off_high_pct: number | string | null }
    | null;
  const sellRow = (sells.data as { txn_date: string; price: number | string }[] | null)?.[0];
  const currentPrice = n(
    (rt.data as { current_price: number | string | null } | null)?.current_price,
  );

  // === ATR sizing(規畫②)===
  let sizing: BuySizing | null = null;
  {
    const barRows = (bars.data as
      | { high: number | string | null; low: number | string | null; close: number | string | null }[]
      | null) ?? [];
    const settingMap = new Map<string, number>();
    for (const r of (sizingSettings.data as { key: string; value: number | string }[] | null) ?? []) {
      const v = Number(r.value);
      if (Number.isFinite(v)) settingMap.set(r.key, v);
    }
    const initialWan = settingMap.get("initial_capital");
    const sum = summary.data as
      | { total_realized_pnl: number | string | null; total_unrealized_pnl: number | string | null }
      | null;
    // TR = max(H−L, |H−前收|, |L−前收|),bars 為日期 desc,bars[i+1].close = 前收
    const trs: number[] = [];
    if (barRows.length >= 15) {
      for (let i = 0; i < 14; i++) {
        const h = n(barRows[i].high);
        const l = n(barRows[i].low);
        const pc = n(barRows[i + 1].close);
        if (h == null || l == null || pc == null || h <= 0 || l <= 0 || pc <= 0) {
          trs.length = 0;
          break;
        }
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      }
    }
    const lastClose = n(barRows[0]?.close);
    const priceForPct = currentPrice ?? lastClose;
    if (trs.length === 14 && initialWan != null && priceForPct != null && priceForPct > 0) {
      const atr14 = trs.reduce((a, b) => a + b, 0) / 14;
      const kMultiple = settingMap.get("atr_stop_multiple") ?? 2;
      const riskPct = settingMap.get("risk_pct_per_trade") ?? 0.01;
      const capital =
        initialWan * 10000 +
        (n(sum?.total_realized_pnl) ?? 0) +
        (n(sum?.total_unrealized_pnl) ?? 0);
      const stopDistance = kMultiple * atr14;
      const lotRisk = stopDistance * 1000;
      let existingValue = 0;
      let portfolioValue = 0;
      for (const r of (pnl.data as { symbol: string; market_value: number | string | null }[] | null) ?? []) {
        const mv = n(r.market_value) ?? 0;
        portfolioValue += mv;
        if (r.symbol === s) existingValue = mv;
      }
      if (capital > 0 && atr14 > 0) {
        sizing = {
          atr14,
          atrPct: (atr14 / priceForPct) * 100,
          kMultiple,
          stopDistance,
          riskPct,
          capital,
          riskBudget: capital * riskPct,
          lotRisk,
          suggestedLots: Math.floor((capital * riskPct) / lotRisk),
          lotValue: currentPrice != null ? currentPrice * 1000 : lastClose != null ? lastClose * 1000 : null,
          existingValue,
          portfolioValue,
        };
      }
    }
  }

  return {
    symbol: s,
    covered: eqRow != null,
    zone: eqRow?.entry_zone ?? null,
    devMa20: n(eqRow?.dev_ma20_pct),
    ret20d: n((pf.data as { ret_20d_pct: number | string | null } | null)?.ret_20d_pct),
    offHigh: n(eqRow?.off_high_pct),
    currentPrice,
    recentSell: sellRow ? { date: sellRow.txn_date, price: Number(sellRow.price) } : null,
    chaseWins,
    chaseLosses,
    reentryWins,
    reentryLosses,
    sizing,
    regimeRet,
    chaseWinRegimeBand: band(chaseWinRegimes),
    chaseLossRegimeBand: band(chaseLossRegimes),
    upcomingEvents: (
      (events.data as { event_type: string; event_date: string }[] | null) ?? []
    ).map((e) => ({ type: e.event_type, date: e.event_date })),
  };
}

// 砍掉一筆 transaction(誤輸入時用,單筆刪)
// 注意:會影響後續 SELL 的 avg_cost 計算,謹慎使用
export async function deleteTransaction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const sb = createClient();
  const { error } = await sb
    .from("holdings_transactions")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/holdings");
  revalidatePath("/");
}

// 讀當沖證交稅率(減半:現股 0.15% / ETF 0.05%)
async function loadDayTradeTax(isEtf: boolean): Promise<number> {
  const sb = createClient();
  const { data } = await sb
    .from("app_settings")
    .select("key, value")
    .in("key", ["day_trade_tax_stock", "day_trade_tax_etf"]);
  const map = new Map<string, number>(
    ((data ?? []) as { key: string; value: number | string }[]).map((r) => [
      r.key,
      Number(r.value),
    ]),
  );
  return isEtf
    ? (map.get("day_trade_tax_etf") ?? 0.0005)
    : (map.get("day_trade_tax_stock") ?? 0.0015);
}

// 新增當沖(day trade)— 同日買賣沖銷,獨立於持股(寫 day_trades 表,不碰移動平均)
export async function addDayTradeTransaction(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  const qty = Number(formData.get("qty"));
  const buyPrice = Number(formData.get("buy_price"));
  const sellPrice = Number(formData.get("sell_price"));
  const tradeDateRaw = String(formData.get("trade_date") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!symbol) throw new Error("股號必填");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("股數必須是正整數");
  if (!Number.isFinite(buyPrice) || buyPrice <= 0)
    throw new Error("買價必須是正數");
  if (!Number.isFinite(sellPrice) || sellPrice <= 0)
    throw new Error("賣價必須是正數");

  const { feeRate } = await loadFeeSettings();
  const dayTradeTax = await loadDayTradeTax(isEtfSymbol(symbol));
  const buyFee = calcFee(qty, buyPrice, feeRate);
  const sellFee = calcFee(qty, sellPrice, feeRate);
  const tax = calcTax(qty, sellPrice, dayTradeTax);
  const tradeDate = tradeDateRaw || new Date().toISOString().slice(0, 10);

  const sb = createClient();
  const { error } = await sb.from("day_trades").insert({
    symbol,
    trade_date: tradeDate,
    qty,
    buy_price: buyPrice,
    sell_price: sellPrice,
    buy_fee: buyFee,
    sell_fee: sellFee,
    tax,
    note,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/holdings");
  revalidatePath("/");
  revalidatePath("/performance");
}

// 到價提醒(2026-07-10 通用化,收回 A3 拆掉的 UI)
// pipeline 沿用:alert_rules → check-price-alerts EF(盤中每 10 分比價)→ TG 推播 + one-shot 停用
export async function addPriceAlert(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  const condition = String(formData.get("condition") ?? "");
  const threshold = Number(formData.get("threshold"));
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!/^[0-9A-Za-z]{4,6}$/.test(symbol)) throw new Error("股號格式錯誤");
  if (condition !== "price_below" && condition !== "price_above")
    throw new Error("條件必須是 price_below / price_above");
  if (!Number.isFinite(threshold) || threshold <= 0)
    throw new Error("目標價必須是正數");

  const sb = createClient();
  // 防重:同 symbol + condition 未觸發規則先停用再插新(重掛 = 更新價)
  await sb
    .from("alert_rules")
    .update({ enabled: false })
    .eq("symbol", symbol)
    .eq("condition", condition)
    .eq("enabled", true);
  const { error } = await sb
    .from("alert_rules")
    .insert({ symbol, condition, threshold, note });
  if (error) throw new Error(`addPriceAlert: ${error.message}`);
  revalidatePath("/holdings");
}

export async function cancelPriceAlert(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id) || id <= 0) throw new Error("提醒 id 錯誤");
  const sb = createClient();
  const { error } = await sb
    .from("alert_rules")
    .update({ enabled: false })
    .eq("id", id);
  if (error) throw new Error(`cancelPriceAlert: ${error.message}`);
  revalidatePath("/holdings");
}
