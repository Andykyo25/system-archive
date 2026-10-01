import { loadAnalysis } from "@/lib/intraday-server";

export const dynamic = "force-dynamic";

// GET /api/intraday/4958 —— 單一股票的即時盤面 + 日線指標 + 系統名單 / 持股狀態。
// 代號嚴格驗證,避免被當成任意 MIS 代理。
export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await ctx.params;
  if (!/^[0-9A-Z]{4,6}$/.test(symbol)) {
    return Response.json({ error: "invalid symbol" }, { status: 400 });
  }
  try {
    const { analysis, notFound } = await loadAnalysis(symbol);
    if (notFound || !analysis) return Response.json({ error: "no data for symbol" }, { status: 404 });
    return Response.json(analysis, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "internal error" }, { status: 500 });
  }
}
