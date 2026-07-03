import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const TPEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";

interface PriceRow {
  symbol: string;
  trade_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  source: "twse" | "tpex";
  is_provisional: boolean;
}

function rocDateToISO(rocDate: string): string {
  const padded = rocDate.padStart(7, "0");
  const year = parseInt(padded.slice(0, 3), 10) + 1911;
  const month = padded.slice(3, 5);
  const day = padded.slice(5, 7);
  return `${year}-${month}-${day}`;
}

function parseTWSE(json: unknown): PriceRow[] {
  if (!Array.isArray(json)) return [];
  // deno-lint-ignore no-explicit-any
  return (json as any[]).flatMap((r): PriceRow[] => {
    const close = parseFloat(r.ClosingPrice);
    if (!Number.isFinite(close) || close <= 0) return []; // close<=0 = 未交易/停牌/髒資料,不寫
    return [{
      symbol: String(r.Code),
      trade_date: rocDateToISO(String(r.Date)),
      open: parseFloat(r.OpeningPrice) || null,
      high: parseFloat(r.HighestPrice) || null,
      low: parseFloat(r.LowestPrice) || null,
      close,
      volume: parseInt(String(r.TradeVolume), 10) || null,
      source: "twse",
      is_provisional: false,
    }];
  });
}

function parseTPEX(json: unknown): PriceRow[] {
  if (!Array.isArray(json)) return [];
  // deno-lint-ignore no-explicit-any
  return (json as any[]).flatMap((r): PriceRow[] => {
    const close = parseFloat(r.Close);
    if (!Number.isFinite(close) || close <= 0) return []; // close<=0 = 未交易/停牌/髒資料,不寫
    return [{
      symbol: String(r.SecuritiesCompanyCode),
      trade_date: rocDateToISO(String(r.Date)),
      open: parseFloat(r.Open) || null,
      high: parseFloat(r.High) || null,
      low: parseFloat(r.Low) || null,
      close,
      volume: parseInt(String(r.TradingShares), 10) || null,
      source: "tpex",
      is_provisional: false,
    }];
  });
}

async function fetchSource(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  source: "twse" | "tpex",
  url: string,
  parser: (j: unknown) => PriceRow[],
  targetSymbols: Set<string>,
) {
  const { data: logRow, error: logErr } = await supabase
    .from("fetch_log").insert({ source }).select("id").single();
  if (logErr) throw logErr;
  const logId = logRow.id;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const allRows = parser(json);
    // B 工程 v8(2026-07-03):全市場寫入 — focus 池照舊 + 全部 4 碼普通股/ETF
    // (雷達層,零 quota;權證等 5-6 碼仍排除)。90 日滾動清理見 cleanup_market_prices。
    const rows = allRows.filter(
      (r) => targetSymbols.has(r.symbol) || /^\d{4}$/.test(r.symbol),
    );
    const focusCount = rows.filter((r) => targetSymbols.has(r.symbol)).length;

    let written = 0;
    let upgraded = 0;
    if (rows.length > 0) {
      // 主力可以覆蓋 provisional(reconcile),但不能覆蓋主力(lock)。
      // 做法:先查出該日 is_provisional=true 的 symbols(fallback 只寫 focus 池,量少),
      //       與本批交集後刪除 → 再 upsert ignoreDuplicates。殘留主力 row 不動。
      // v8 註:改「先查再交集」因全市場 ~1800 symbols 塞進 .in() 會爆 URL 長度。
      const dates = new Set(rows.map((r) => r.trade_date));
      const symbolSet = new Set(rows.map((r) => r.symbol));
      for (const date of dates) {
        const { data: provRows } = await supabase
          .from("price_daily")
          .select("symbol")
          .eq("trade_date", date)
          .eq("is_provisional", true);
        const toDelete = ((provRows ?? []) as { symbol: string }[])
          .map((r) => r.symbol)
          .filter((s) => symbolSet.has(s));
        if (toDelete.length > 0) {
          const { data: del } = await supabase
            .from("price_daily")
            .delete()
            .in("symbol", toDelete)
            .eq("trade_date", date)
            .eq("is_provisional", true)
            .select("symbol");
          upgraded += del?.length ?? 0;
        }
      }

      // 分批 upsert(全市場 ~1800 rows,500/批避免單請求過大)
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { data, error } = await supabase
          .from("price_daily")
          .upsert(chunk, { onConflict: "symbol,trade_date", ignoreDuplicates: true })
          .select("symbol");
        if (error) throw error;
        written += data?.length ?? 0;
      }
    }
    const skipped = rows.length - written;

    await supabase.from("fetch_log").update({
      finished_at: new Date().toISOString(),
      success: true,
      rows_written: written,
      rows_skipped: skipped,
    }).eq("id", logId);

    return { source, fetched: allRows.length, matched: rows.length, matched_focus: focusCount, written, upgraded, skipped };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from("fetch_log").update({
      finished_at: new Date().toISOString(),
      success: false,
      error: msg,
    }).eq("id", logId);
    return { source, error: msg };
  }
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

Deno.serve(async (req: Request) => {
  // verify_jwt:true 讓平台先驗簽,這裡只負責 role 授權
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
    return Response.json({ error: "missing SUPABASE_SERVICE_ROLE_KEY env" }, { status: 500 });
  }
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);

  // 收料 symbol 單一來源 v_fetch_universe(根治 holdings_transactions 漏收 drift)。
  // fallback:view 異常 → 退回原 holdings/watchlist/industry/etf query(零退化)。
  const fu = await supabase.from("v_fetch_universe").select("symbol");
  const targetSymbols = new Set<string>();
  if (fu.error) {
    const [holdings, watchlist, industry, etf] = await Promise.all([
      supabase.from("holdings").select("symbol").is("closed_at", null),
      supabase.from("watchlist").select("symbol"),
      supabase.from("industry_stocks").select("symbol"),
      supabase.from("etf_metadata").select("symbol"),
    ]);
    if (holdings.error) {
      return Response.json({ error: "holdings query", detail: holdings.error.message }, { status: 500 });
    }
    if (watchlist.error) {
      return Response.json({ error: "watchlist query", detail: watchlist.error.message }, { status: 500 });
    }
    if (industry.error) {
      return Response.json({ error: "industry_stocks query", detail: industry.error.message }, { status: 500 });
    }
    if (etf.error) {
      return Response.json({ error: "etf_metadata query", detail: etf.error.message }, { status: 500 });
    }
    for (const r of holdings.data ?? []) targetSymbols.add(r.symbol);
    for (const r of watchlist.data ?? []) targetSymbols.add(r.symbol);
    for (const r of industry.data ?? []) targetSymbols.add(r.symbol);
    for (const r of etf.data ?? []) targetSymbols.add(r.symbol);
  } else {
    for (const r of fu.data ?? []) targetSymbols.add(r.symbol);
  }

  if (targetSymbols.size === 0) {
    return Response.json({
      skipped: "no_target_symbols",
      hint: "add rows to public.holdings or public.watchlist first",
    });
  }

  const results = await Promise.all([
    fetchSource(supabase, "twse", TWSE_URL, parseTWSE, targetSymbols),
    fetchSource(supabase, "tpex", TPEX_URL, parseTPEX, targetSymbols),
  ]);

  return Response.json({ target_symbols: Array.from(targetSymbols).sort(), results });
});
