// fetch-intl-news — 持股相關國際新聞(晨間情報改版 2026-07-11)
//
// 讀 v_holdings_current → 持股產業(industry_stocks)→ 對應國際 topic(英文查詢)
// → Google News RSS(hl=en-US;同 fetch-stock-news 的 parseRSS 模式,2026-07-11 實證
//   Yahoo search news 對韓股回無關內容 → 棄用,Google News RSS 才可靠)
// 寫入 stock_news:symbol = topic tag(如 MU / 005930.KS),source = google_news_intl
// → dashboard HoldingsIntelWidget 以 tag 對映持股產業顯示。
// 保留策略沿用 fetch-stock-news 的全表 30 天清理(它 delete 不分 source)。
// Cron:平日 07:50 Taipei(23:50 UTC 前一日),美股收盤後 / 台股開盤前。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const NEWS_BASE = "https://news.google.com/rss/search";
const MAX_NEWS_PER_TOPIC = 12;
const TOPIC_THROTTLE_MS = 80;

// 產業 → 國際 topic(tag 與 overseas_indicators / overseas-map 的 symbol 對齊)
const INDUSTRY_TOPICS: Record<string, { tag: string; q: string }[]> = {
  "記憶體": [
    { tag: "MU", q: "Micron Technology memory" },
    { tag: "005930.KS", q: "Samsung Electronics semiconductor" },
    { tag: "000660.KS", q: "SK Hynix" },
  ],
  "IC設計": [
    { tag: "TSM", q: "TSMC" },
    { tag: "NVDA", q: "Nvidia" },
  ],
  "半導體封測": [{ tag: "TSM", q: "TSMC" }],
  "AI伺服器": [{ tag: "NVDA", q: "Nvidia AI server" }],
};
// 產業未映射時的通用 fallback(半導體/台股大盤視角)
const GENERIC_TOPICS: { tag: string; q: string }[] = [
  { tag: "^SOX", q: "semiconductor stocks" },
];

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
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
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

async function fetchTopic(tag: string, q: string): Promise<NewsItem[]> {
  const url = new URL(NEWS_BASE);
  url.searchParams.set("q", q);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  return parseRSS(xml)
    .slice(0, MAX_NEWS_PER_TOPIC)
    .map((it): NewsItem => {
      let publishedISO: string | null = null;
      if (it.published) {
        const d = new Date(it.published);
        if (!Number.isNaN(d.getTime())) publishedISO = d.toISOString();
      }
      return {
        symbol: tag,
        title: it.title,
        url: it.url,
        published_at: publishedISO,
        source: "google_news_intl",
      };
    });
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return Response.json({ error: "missing bearer" }, { status: 401 });
  let role: unknown;
  try { role = decodeJwtPayload(auth.slice(7)).role; }
  catch { return Response.json({ error: "invalid jwt" }, { status: 401 }); }
  if (role !== "service_role") return Response.json({ error: "forbidden" }, { status: 403 });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const [holdings, industries] = await Promise.all([
    sb.from("v_holdings_current").select("symbol"),
    sb.from("industry_stocks").select("symbol, industry"),
  ]);
  const industryMap = new Map<string, string>();
  for (const r of (industries.data as { symbol: string; industry: string | null }[] | null) ?? []) {
    if (r.industry) industryMap.set(r.symbol, r.industry);
  }

  // 持股產業 → topic 集合(tag 去重);未映射產業 / 無產業 → GENERIC
  const topics = new Map<string, string>(); // tag -> q
  for (const h of (holdings.data as { symbol: string }[] | null) ?? []) {
    const ind = industryMap.get(h.symbol);
    const list = (ind && INDUSTRY_TOPICS[ind]) || GENERIC_TOPICS;
    for (const t of list) if (!topics.has(t.tag)) topics.set(t.tag, t.q);
  }
  if (topics.size === 0) return Response.json({ skipped: "no_holdings" });

  const { data: logRow } = await sb
    .from("fetch_log").insert({ source: "google_news_intl" }).select("id").single();
  const logId = logRow!.id;

  let written = 0;
  const errors: string[] = [];
  for (const [tag, q] of topics) {
    try {
      const items = await fetchTopic(tag, q);
      if (items.length > 0) {
        const { data, error } = await sb
          .from("stock_news")
          .upsert(items, { onConflict: "symbol,url", ignoreDuplicates: true })
          .select("id");
        if (error) throw error;
        written += data?.length ?? 0;
      }
    } catch (e) {
      errors.push(`${tag}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, TOPIC_THROTTLE_MS));
  }

  await sb.from("fetch_log").update({
    finished_at: new Date().toISOString(),
    success: errors.length === 0,
    rows_written: written,
    error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null,
  }).eq("id", logId);

  return Response.json({ topics: topics.size, written, errors: errors.length });
});
