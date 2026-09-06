export interface MisQuote {
  c?: string;     // symbol
  ch?: string;    // channel "tse_2330.tw_"
  z?: string;     // latest trade price; may be throttled to "-"
  pz?: string;
  y?: string;     // previous close
  o?: string;
  h?: string;
  l?: string;
  a?: string;     // ask levels, best price first
  b?: string;     // bid levels, best price first
  tv?: string;
  tlong?: string; // provider quote timestamp in Unix milliseconds
  d?: string;     // provider quote date, YYYYMMDD when present
  ex?: string;
}

export interface IntradayRow {
  symbol: string;
  quoted_at: string;
  price: number;
  volume: number | null;
  change_pct: number | null;
  market_state: string | null;
  currency: string | null;
  source: "twse_mis" | "twse_mis_mid";
}

function toN(v: unknown): number | null {
  if (v == null || v === "" || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Taiwan does not observe daylight saving time. Keep this pure for Node tests.
function taipeiClock(timestamp: number): Date {
  return new Date(timestamp + 8 * 60 * 60 * 1000);
}

function isRegularSession(timestamp: number): boolean {
  const clock = taipeiClock(timestamp);
  const day = clock.getUTCDay();
  const seconds = clock.getUTCHours() * 3600 + clock.getUTCMinutes() * 60 + clock.getUTCSeconds();
  return day >= 1 && day <= 5 && seconds >= 9 * 3600 && seconds <= 13.5 * 3600;
}

export function quoteToRow(q: MisQuote, fetchedAt: string): IntradayRow | null {
  // A successful fetch is not a new quote. Missing, inconsistent, future, or
  // previous-day provider timestamps must never be replaced with fetchedAt.
  const rawTimestamp = typeof q.tlong === "string" ? q.tlong.trim() : "";
  if (!/^\d+$/.test(rawTimestamp)) return null;
  const quotedMs = Number(rawTimestamp);
  const fetchedMs = Date.parse(fetchedAt);
  if (!Number.isSafeInteger(quotedMs) || quotedMs <= 0 || !Number.isFinite(fetchedMs)
    || quotedMs > fetchedMs) return null;
  const quotedClock = taipeiClock(quotedMs);
  if (!Number.isFinite(quotedClock.getTime())) return null;
  const quoteDate = quotedClock.toISOString().slice(0, 10);
  if (quoteDate !== taipeiClock(fetchedMs).toISOString().slice(0, 10)) return null;
  if (q.d != null && (typeof q.d !== "string" || q.d !== quoteDate.replaceAll("-", ""))) return null;

  // Preserve the existing price fallback, explicitly separating trade prices
  // from order-book midpoints. Alert consumers must require source=twse_mis.
  const z = toN(q.z);
  let price: number;
  let source: IntradayRow["source"];
  if (z != null && z > 0) {
    price = z;
    source = "twse_mis";
  } else {
    const ask = toN((q.a ?? "").split("_")[0]);
    const bid = toN((q.b ?? "").split("_")[0]);
    if (ask == null || bid == null || ask <= 0 || bid <= 0) return null;
    price = (ask + bid) / 2;
    source = "twse_mis_mid";
  }
  const symbol = q.c ?? "";
  if (!symbol) return null;
  const prev = toN(q.y);

  return {
    symbol,
    quoted_at: new Date(quotedMs).toISOString(),
    price,
    volume: toN(q.tv),
    change_pct: prev != null && prev > 0 ? ((price - prev) / prev) * 100 : null,
    // The payload does not certify exchange session status. Only flag regular
    // during regular hours for both the quote and receipt; otherwise unknown.
    market_state: isRegularSession(quotedMs) && isRegularSession(fetchedMs) ? "REGULAR" : null,
    currency: "TWD",
    source,
  };
}

export function deduplicateQuotes(rows: IntradayRow[]): IntradayRow[] {
  const unique = new Map<string, IntradayRow>();
  for (const row of rows) {
    const key = `${row.symbol}:${row.quoted_at}`;
    const previous = unique.get(key);
    // Dual exchange channels or repeated payload entries can share the cache
    // primary key. PostgreSQL cannot update one key twice in a single upsert.
    // When equal-time quotes disagree on provenance, keep the trade price.
    if (!previous || previous.source !== "twse_mis" || row.source === "twse_mis") {
      unique.set(key, row);
    }
  }
  return [...unique.values()];
}
