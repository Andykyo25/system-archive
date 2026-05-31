// 法人三大買賣超 fetcher
// FinMind TaiwanStockInstitutionalInvestorsBuySell 是 long format,
// 每 (date, stock_id) 多筆 row,以 name 區分法人類別:
//   Foreign_Investor / Foreign_Dealer_Self / Investment_Trust / Dealer_self / Dealer_Hedging
// 我們 pivot 成 wide format,每 (symbol, trade_date) 一筆 row 寫入 stock_institutional

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const FINMIND_DAILY_BUDGET = 600;
const LOOKBACK_DAYS = 10; // 抓最近 10 天確保補齊任何遺漏

interface InstRow {
  symbol: string;
  trade_date: string;
  foreign_buy: number;
  foreign_sell: number;
  foreign_net: number;
  invest_trust_buy: number;
  invest_trust_sell: number;
  invest_trust_net: number;
  dealer_self_buy: number;
  dealer_self_sell: number;
  dealer_self_net: number;
  dealer_hedging_buy: number;
  dealer_hedging_sell: number;
  dealer_hedging_net: number;
  three_major_net: number;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
}

async function fetchInstForSymbol(
  token: string,
  symbol: string,
  startDate: string,
  endDate: string,
): Promise<InstRow[]> {
  const u = new URL(FINMIND_URL);
  u.searchParams.set("dataset", "TaiwanStockInstitutionalInvestorsBuySell");
  u.searchParams.set("data_id", symbol);
  u.searchParams.set("start_date", startDate);
  u.searchParams.set("end_date", endDate);
  u.searchParams.set("token", token);

  const res = await fetch(u);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 200) throw new Error(`FinMind status=${j.status} msg=${j.msg}`);
  if (!Array.isArray(j.data)) return [];

  // pivot:(date, stock_id) → { name -> {buy, sell} }
  const pivot = new Map<string, {
    foreign_buy: number; foreign_sell: number;
    invest_trust_buy: number; invest_trust_sell: number;
    dealer_self_buy: number; dealer_self_sell: number;
    dealer_hedging_buy: number; dealer_hedging_sell: number;
  }>();

  // deno-lint-ignore no-explicit-any
  for (const r of j.data as any[]) {
    const key = `${r.stock_id}|${r.date}`;
    if (!pivot.has(key)) {
      pivot.set(key, {
        foreign_buy: 0, foreign_sell: 0,
        invest_trust_buy: 0, invest_trust_sell: 0,
        dealer_self_buy: 0, dealer_self_sell: 0,
        dealer_hedging_buy: 0, dealer_hedging_sell: 0,
      });
    }
    const slot = pivot.get(key)!;
    const buy = Number(r.buy) || 0;
    const sell = Number(r.sell) || 0;
    const name = String(r.name);
    if (name === "Foreign_Investor") {
      slot.foreign_buy += buy; slot.foreign_sell += sell;
    } else if (name === "Foreign_Dealer_Self") {
      // FinMind 中外資自營商也視作 foreign,合進 foreign net
      slot.foreign_buy += buy; slot.foreign_sell += sell;
    } else if (name === "Investment_Trust") {
      slot.invest_trust_buy += buy; slot.invest_trust_sell += sell;
    } else if (name === "Dealer_self") {
      slot.dealer_self_buy += buy; slot.dealer_self_sell += sell;
    } else if (name === "Dealer_Hedging") {
      slot.dealer_hedging_buy += buy; slot.dealer_hedging_sell += sell;
    }
    // 其他 name 忽略
  }

  const rows: InstRow[] = [];
  for (const [key, p] of pivot) {
    const [stockId, date] = key.split("|");
    const foreign_net = p.foreign_buy - p.foreign_sell;
    const invest_trust_net = p.invest_trust_buy - p.invest_trust_sell;
    const dealer_self_net = p.dealer_self_buy - p.dealer_self_sell;
    const dealer_hedging_net = p.dealer_hedging_buy - p.dealer_hedging_sell;
    rows.push({
      symbol: stockId,
      trade_date: date,
      foreign_buy: p.foreign_buy,
      foreign_sell: p.foreign_sell,
      foreign_net,
      invest_trust_buy: p.invest_trust_buy,
      invest_trust_sell: p.invest_trust_sell,
      invest_trust_net,
      dealer_self_buy: p.dealer_self_buy,
      dealer_self_sell: p.dealer_self_sell,
      dealer_self_net,
      dealer_hedging_buy: p.dealer_hedging_buy,
      dealer_hedging_sell: p.dealer_hedging_sell,
      dealer_hedging_net,
      three_major_net: foreign_net + invest_trust_net + dealer_self_net + dealer_hedging_net,
    });
  }
  return rows;
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

  const tokenRes = await supabase.rpc("read_finmind_token");
  if (tokenRes.error || !tokenRes.data) {
    return Response.json({ error: "missing finmind_token in vault", detail: tokenRes.error?.message }, { status: 500 });
  }
  const TOKEN = tokenRes.data as string;

  // ETF 沒法人買賣超(嚴格說有,但意義不同),只抓個股 → 讀 v_fetch_universe_stocks(stock 底集,不含 ETF)
  // 收料 symbol 單一來源(L42 做法3 籌碼側統一,根治籌碼/價格兩套 pattern drift)。
  // fallback:view 異常 → 退回原 v_holdings_current/watchlist/industry/stock_universe query(零退化,鏡像 c4e850f)。
  const fu = await supabase.from("v_fetch_universe_stocks").select("symbol");
  const targetSymbols = new Set<string>();
  if (fu.error) {
    const [holdingsCurrent, watchlist, industry, universe] = await Promise.all([
      supabase.from("v_holdings_current").select("symbol"),
      supabase.from("watchlist").select("symbol"),
      supabase.from("industry_stocks").select("symbol"),
      supabase.from("stock_universe").select("symbol"),
    ]);
    if (holdingsCurrent.error) {
      // M8.5 還沒套用時 fallback 到舊 holdings 表
      const { data: oldHoldings } = await supabase.from("holdings").select("symbol").is("closed_at", null);
      for (const r of oldHoldings ?? []) targetSymbols.add(r.symbol);
    } else {
      for (const r of holdingsCurrent.data ?? []) targetSymbols.add(r.symbol);
    }
    for (const r of watchlist.data ?? []) targetSymbols.add(r.symbol);
    for (const r of industry.data ?? []) targetSymbols.add(r.symbol);
    for (const r of universe.data ?? []) targetSymbols.add(r.symbol);
  } else {
    for (const r of fu.data ?? []) targetSymbols.add(r.symbol);
  }
  if (targetSymbols.size === 0) return Response.json({ skipped: "no_target_symbols" });

  const today = new Date().toISOString().slice(0, 10);
  const startDate = isoDaysAgo(LOOKBACK_DAYS);

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
    .from("fetch_log").insert({ source: "finmind_institutional" }).select("id").single();
  const logId = logRow!.id;

  let written = 0;
  let apiCalls = 0;
  const errors: string[] = [];

  for (const symbol of targetSymbols) {
    if (apiCalls >= remaining) {
      errors.push(`quota exhausted at ${symbol}`);
      break;
    }
    try {
      apiCalls++;
      const rows = await fetchInstForSymbol(TOKEN, symbol, startDate, today);
      if (rows.length > 0) {
        // First-write-wins(per L11/L17)— ON CONFLICT DO NOTHING
        // 法人資料是定型不變的(同 trade_date 只有一個正確答案),所以 first-write-wins 完全安全
        const { error } = await supabase
          .from("stock_institutional")
          .upsert(rows, { onConflict: "symbol,trade_date", ignoreDuplicates: true });
        if (error) throw error;
        written += rows.length;
      }
    } catch (e) {
      errors.push(`${symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // B1:原子遞增(取代 read-modify-write,並行不覆蓋)
  await supabase.rpc("increment_quota", { p_source: "finmind", p_date: today, p_n: apiCalls });

  await supabase.from("fetch_log").update({
    finished_at: new Date().toISOString(),
    success: errors.length === 0,
    rows_written: written,
    error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null,
  }).eq("id", logId);

  return Response.json({
    target_symbols: targetSymbols.size,
    api_calls: apiCalls,
    written,
    errors: errors.length,
    quota: { used: usedSoFar + apiCalls, budget },
  });
});
