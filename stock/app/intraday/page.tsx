import { createClient } from "@/lib/supabase/server";
import { IntradayLive, type QuickItem } from "./IntradayLive";

export const dynamic = "force-dynamic";

// 盤中即時分析:頁面只負責「快選名單」(持股 + 今日看多)與初始代號,
// 即時盤面由 client 輪詢 /api/intraday/[symbol](lib/intraday-server.ts)。
export default async function IntradayPage({
  searchParams,
}: {
  searchParams: Promise<{ symbol?: string }>;
}) {
  const { symbol } = await searchParams;
  const initial = symbol && /^[0-9A-Z]{4,6}$/.test(symbol) ? symbol : null;

  const sb = createClient();
  const [holdR, verdictR] = await Promise.all([
    sb.from("v_holdings_current").select("symbol").gt("net_qty", 0),
    sb.from("v_verdict_live").select("symbol,name"),
  ]);
  const holdSyms = (holdR.data ?? []).map((r) => String(r.symbol));
  const nameR = holdSyms.length
    ? await sb.from("stock_names").select("symbol,name").in("symbol", holdSyms)
    : { data: [] as { symbol: string; name: string | null }[] };
  const names = new Map((nameR.data ?? []).map((r) => [String(r.symbol), r.name as string | null]));

  const holdings: QuickItem[] = holdSyms.map((s) => ({ symbol: s, name: names.get(s) ?? null }));
  const verdict: QuickItem[] = (verdictR.data ?? []).map((r) => ({
    symbol: String(r.symbol),
    name: (r.name as string | null) ?? null,
  }));

  return <IntradayLive initialSymbol={initial} holdings={holdings} verdict={verdict} />;
}
