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
    if (!Number.isFinite(close)) return [];
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
    if (!Number.isFinite(close)) return [];
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
    const rows = allRows.filter((r) => targetSymbols.has(r.symbol));

    let written = 0;
    if (rows.length > 0) {
      const { data, error } = await supabase
        .from("price_daily")
        .upsert(rows, { onConflict: "symbol,trade_date", ignoreDuplicates: true })
        .select("symbol");
      if (error) throw error;
      written = data?.length ?? 0;
    }
    const skipped = rows.length - written;

    await supabase.from("fetch_log").update({
      finished_at: new Date().toISOString(),
      success: true,
      rows_written: written,
      rows_skipped: skipped,
    }).eq("id", logId);

    return { source, fetched: allRows.length, matched: rows.length, written, skipped };
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

  const [holdings, watchlist, industry] = await Promise.all([
    supabase.from("holdings").select("symbol").is("closed_at", null),
    supabase.from("watchlist").select("symbol"),
    supabase.from("industry_stocks").select("symbol"),
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

  const targetSymbols = new Set<string>();
  for (const r of holdings.data ?? []) targetSymbols.add(r.symbol);
  for (const r of watchlist.data ?? []) targetSymbols.add(r.symbol);
  for (const r of industry.data ?? []) targetSymbols.add(r.symbol);

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
