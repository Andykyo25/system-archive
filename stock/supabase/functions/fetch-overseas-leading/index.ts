import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Overseas / overnight leading indicators fetcher (Yahoo v8 chart API).
//
// Pulls daily close for ^SOX / TSM / ^IXIC / NQ=F / ^VIX / UMC. Each US-session
// close is mapped to the TW trading day it feeds into pre-open (quoted_date =
// Taipei calendar date of the close timestamp; a US close ~20:00 UTC becomes
// ~04:00 next-day Taipei => the TW day that opens after that overnight session).
//
// Modes (same EF): realtime range=5d (default, cron pre-open); backfill pass
// range=2y in body. Cache semantics => upsert on (symbol, quoted_date).
//
// Yahoo v8 is an UNOFFICIAL endpoint (may change/rate-limit). Runs in schedule
// only (never user path, L02); per-symbol try/catch graceful; writes fetch_log.

const YF = "https://query1.finance.yahoo.com/v8/finance/chart/";
// US leaders by sector - drive sector-matched TW stocks (most TW names have no
// ADR, so the US sector leader is the proxy): MU=memory (Winbond 2344 / Nanya /
// Macronix), NVDA=AI/GPU chain, AAPL=Apple chain (Foxconn / Largan),
// AVGO=ASIC/networking, AMD=CPU/GPU, ^SOX=semis broad, TSM/UMC=direct ADR,
// ^IXIC/NQ=F/^VIX=market/risk.
const DEFAULT_SYMBOLS = [
  "^SOX", "TSM", "UMC", "^IXIC", "NQ=F", "^VIX",
  "MU", "NVDA", "AAPL", "AVGO", "AMD",
];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

// unix seconds -> Taipei (UTC+8) calendar date YYYY-MM-DD.
function taipeiDate(unixSec: number): string {
  return new Date(unixSec * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

interface Row {
  symbol: string;
  quoted_date: string;
  market_time: string;
  last_price: number;
  prev_close: number | null;
  change_pct: number | null;
}

async function fetchSymbol(symbol: string, range: string): Promise<Row[]> {
  const url = `${YF}${encodeURIComponent(symbol)}?interval=1d&range=${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j?.chart?.error) throw new Error(`yahoo: ${JSON.stringify(j.chart.error)}`);
  const r = j?.chart?.result?.[0];
  if (!r) return [];
  const ts: number[] = r.timestamp ?? [];
  const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
  const out: Row[] = [];
  let lastValid: number | null = null;
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c) || c <= 0) continue;
    out.push({
      symbol,
      quoted_date: taipeiDate(ts[i]),
      market_time: new Date(ts[i] * 1000).toISOString(),
      last_price: c,
      prev_close: lastValid,
      change_pct: lastValid != null && lastValid > 0 ? (c / lastValid - 1) * 100 : null,
    });
    lastValid = c;
  }
  return out;
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

  let body: { range?: string; symbols?: string[] } = {};
  try { body = await req.json(); } catch { /* no body ok */ }
  const range = body.range ?? "5d";
  const symbols = body.symbols && body.symbols.length > 0 ? body.symbols : DEFAULT_SYMBOLS;

  const { data: logRow } = await supabase
    .from("fetch_log").insert({ source: "overseas_leading" }).select("id").single();
  const logId = logRow!.id;

  let written = 0;
  const errors: string[] = [];
  for (const sym of symbols) {
    try {
      const rows = await fetchSymbol(sym, range);
      if (rows.length > 0) {
        const { error } = await supabase
          .from("overseas_indicators")
          .upsert(rows, { onConflict: "symbol,quoted_date" });
        if (error) throw error;
        written += rows.length;
      }
    } catch (e) {
      errors.push(`${sym}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await supabase.from("fetch_log").update({
    finished_at: new Date().toISOString(),
    success: errors.length === 0,
    rows_written: written,
    error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null,
  }).eq("id", logId);

  return Response.json({
    range,
    symbols: symbols.length,
    written,
    errors: errors.length,
    error_detail: errors.slice(0, 10),
  });
});
