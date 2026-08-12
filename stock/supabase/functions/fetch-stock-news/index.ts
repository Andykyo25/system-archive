import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const NEWS_BASE = "https://news.google.com/rss/search";
const MAX_NEWS_PER_SYMBOL = 20;
const NEWS_RETENTION_DAYS = 30;
const SYMBOL_THROTTLE_MS = 80;

interface NewsItem {
  symbol: string;
  title: string;
  url: string;
  published_at: string | null;
  source: string;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid jwt shape");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return JSON.parse(atob(pad));
}

function unescapeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

interface ParsedItem {
  title: string;
  url: string;
  published: string | null;
}

function parseRSS(xml: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const itemXml = m[1];
    const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/);
    const dateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (titleMatch && linkMatch) {
      items.push({
        title: unescapeXml(titleMatch[1].trim()).slice(0, 500),
        url: linkMatch[1].trim().slice(0, 1500),
        published: dateMatch ? dateMatch[1].trim() : null,
      });
    }
  }
  return items;
}

async function fetchNewsForSymbol(
  symbol: string,
  name: string | null,
): Promise<NewsItem[]> {
  const query = name ? `${symbol} ${name}` : `${symbol} 台股`;
  const url = new URL(NEWS_BASE);
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "zh-TW");
  url.searchParams.set("gl", "TW");
  url.searchParams.set("ceid", "TW:zh-Hant");

  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();

  const items = parseRSS(xml).slice(0, MAX_NEWS_PER_SYMBOL);
  return items.map((it): NewsItem => {
    let publishedISO: string | null = null;
    if (it.published) {
      const d = new Date(it.published);
      if (!Number.isNaN(d.getTime())) publishedISO = d.toISOString();
    }
    return {
      symbol,
      title: it.title,
      url: it.url,
      published_at: publishedISO,
      source: "google_news",
    };
  });
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

  // 收集所有 target symbol + 中文名(搜尋關鍵字用)。
  // B2(L46):target 改讀 v_fetch_universe(= 持股 v_holdings_current ∪ watchlist
  //   ∪ industry ∪ stock_universe ∪ etf),取代原「holdings(舊表)+industry+etf」
  //   — 原本漏 stock_universe ~150 檔自選池 + watchlist + transaction-log 持股。
  const [fu, universe, industry, etf] = await Promise.all([
    supabase.from("v_fetch_universe").select("symbol"),
    supabase.from("stock_universe").select("symbol, name"),
    supabase.from("industry_stocks").select("symbol, name").order("symbol"),
    supabase.from("etf_metadata").select("symbol, name").order("symbol"),
  ]);

  // name lookup(搜尋關鍵字):industry > etf > universe
  const nameLookup = new Map<string, string | null>();
  for (const r of industry.data ?? []) if (!nameLookup.has(r.symbol)) nameLookup.set(r.symbol, r.name);
  for (const r of etf.data ?? []) if (!nameLookup.has(r.symbol)) nameLookup.set(r.symbol, r.name);
  for (const r of universe.data ?? []) if (!nameLookup.has(r.symbol)) nameLookup.set(r.symbol, r.name);

  // target = v_fetch_universe(持股優先全涵蓋);fallback:view 異常退回舊三源(零退化)
  const nameMap = new Map<string, string | null>();
  if (fu.error) {
    const { data: oldH } = await supabase.from("holdings").select("symbol").is("closed_at", null);
    for (const r of oldH ?? []) nameMap.set(r.symbol, nameLookup.get(r.symbol) ?? null);
    for (const [s, n] of nameLookup) if (!nameMap.has(s)) nameMap.set(s, n);
  } else {
    for (const r of fu.data ?? []) nameMap.set(r.symbol, nameLookup.get(r.symbol) ?? null);
  }

  if (nameMap.size === 0) return Response.json({ skipped: "no_target_symbols" });

  // 分批(2026-08-12):Supabase EF wall-clock 是 150 秒。本 EF 每檔 ~0.2 秒
  // (SYMBOL_THROTTLE_MS 80ms + RSS 往返),universe 從 547 長到 594 之後
  // 就整批撞牆 —— 最後一次成功是 8/06 06:00 花了 110 秒,之後每次 546 被砍,
  // fetch_log 停在 success is null(開了沒收尾)。
  // 用與 fetch-finmind-backfill 同名的 symbol_offset / symbol_limit 切批,
  // 由 cron 分次呼叫;不傳 = 全跑(等於現狀,退版安全)。
  let body: { symbol_offset?: number; symbol_limit?: number } = {};
  try { body = await req.json(); } catch { /* 無 body 視為全跑 */ }
  const allSymbols = [...nameMap];
  const offset = body.symbol_offset ?? 0;
  const limit = body.symbol_limit ?? allSymbols.length;
  const batch = allSymbols.slice(offset, offset + limit);
  if (batch.length === 0) return Response.json({ skipped: "no_symbols_in_batch", offset, limit });

  const { data: logRow } = await supabase
    .from("fetch_log").insert({ source: "google_news" }).select("id").single();
  const logId = logRow!.id;

  let written = 0;
  let apiCalls = 0;
  const errors: string[] = [];

  for (const [symbol, name] of batch) {
    try {
      apiCalls++;
      const items = await fetchNewsForSymbol(symbol, name);
      if (items.length > 0) {
        const { data, error } = await supabase
          .from("stock_news")
          .upsert(items, { onConflict: "symbol,url", ignoreDuplicates: true })
          .select("id");
        if (error) throw error;
        written += data?.length ?? 0;
      }
    } catch (e) {
      errors.push(`${symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, SYMBOL_THROTTLE_MS));
  }

  // 清舊資料(NEWS_RETENTION_DAYS 之前 published 的)
  // B2 衍生:null published_at(pubDate 解析失敗)對 lt 永不成立 → 永久殘留表膨脹。
  //   改 or(is null OR < cutoff)一併清掉解析失敗的舊 row。
  // 只在第一批做:清理與 symbol 無關,分批後每批都跑等於同一件事做 N 次。
  if (offset === 0) {
    const cutoff = new Date(Date.now() - NEWS_RETENTION_DAYS * 86400 * 1000).toISOString();
    await supabase.from("stock_news").delete().or(`published_at.is.null,published_at.lt.${cutoff}`);
  }

  await supabase.from("fetch_log").update({
    finished_at: new Date().toISOString(),
    success: errors.length === 0,
    rows_written: written,
    error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null,
  }).eq("id", logId);

  return Response.json({
    target_symbols: nameMap.size,
    batch: { offset, limit, size: batch.length },
    api_calls: apiCalls,
    written,
    errors: errors.length,
  });
});
