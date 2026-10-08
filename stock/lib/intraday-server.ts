import "server-only";
import { createClient } from "@/lib/supabase/server";
import { dailyStats, supplyAbove, toQuote, type Analysis, type DailyBar, type MisRaw, type Quote } from "@/lib/intraday";
import { holdingDates } from './holding-analysis';
import { decideHolding, type HoldingEvidence, type HoldingDecision } from './holding-decision';

const MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const n = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

// 與 fetch-yahoo-intraday 同一個來源(TWSE MIS)。上市 / 上櫃代號未知 → 兩個 channel 都掛,無效者回空殼。
// MIS 的 TLS 連線會間歇性被重置(實測連續 3 次失敗後恢復,curl 直連也會),所以連線層失敗重試最多 3 次;
// HTTP 層錯誤與「查無此代號」是確定結果,不重試。
async function fetchMis(symbol: string): Promise<{ raw: MisRaw | null; error: string | null }> {
  const u = new URL(MIS_URL);
  u.searchParams.set("ex_ch", `tse_${symbol}.tw|otc_${symbol}.tw`);
  u.searchParams.set("json", "1");
  u.searchParams.set("delay", "0");
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(u, {
        headers: { Referer: "https://mis.twse.com.tw/stock/", "User-Agent": UA, Accept: "application/json, text/plain, */*" },
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) return { raw: null, error: `MIS HTTP ${r.status}` };
      const j = (await r.json()) as { msgArray?: MisRaw[] };
      const raw = (j.msgArray ?? []).find((x) => x.c === symbol) ?? null;
      return raw ? { raw, error: null } : { raw: null, error: "MIS 無此代號資料" };
    } catch (e) {
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
      lastError = `${e instanceof Error ? e.message : String(e)}${cause ? `(${cause})` : ""}`;
      if (attempt < 3) await new Promise((res) => setTimeout(res, 400 * attempt));
    }
  }
  return { raw: null, error: `MIS 連線失敗(已重試 3 次):${lastError}` };
}

// 讀取失敗一律降級為 null(該區塊不顯示),不讓單一表壞掉整頁無法使用;錯誤原因回給呼叫端。
export async function loadAnalysis(symbol: string): Promise<{ analysis: Analysis | null; notFound: boolean }> {
  const sb = createClient();
  const [mis, barsR, verdictR, holdR, setR, nameR] = await Promise.all([
    fetchMis(symbol),
    sb.from("price_daily").select("trade_date,high,low,close,volume,adj_factor")
      .eq("symbol", symbol).gt("close", 0).order("trade_date", { ascending: false }).limit(130),
    sb.from("v_verdict_live").select("watch_date,entry_min,entry_max,stop_price,state,reason").eq("symbol", symbol).maybeSingle(),
    sb.from("v_holdings_current").select("net_qty,avg_cost").eq("symbol", symbol).maybeSingle(),
    sb.from("app_settings").select("value").eq("key", "atr_stop_multiple").maybeSingle(),
    sb.from("stock_names").select("name").eq("symbol", symbol).maybeSingle(),
  ]);

  const bars: DailyBar[] = (barsR.data ?? []).reverse().map((b) => ({
    d: String(b.trade_date), h: n(b.high), l: n(b.low), c: Number(b.close), v: n(b.volume), f: n(b.adj_factor) ?? 1,
  }));
  const quote: Quote | null = mis.raw ? toQuote(mis.raw) : null;

  // MIS 失敗 → 退回 price_intraday_cache 最新價(沒有五檔),頁面標示「五檔暫缺」
  let fallback: Analysis["fallback"] = null;
  if (!quote) {
    const { data } = await sb.from("price_intraday_cache").select("price,quoted_at")
      .eq("symbol", symbol).order("quoted_at", { ascending: false }).limit(1);
    const row = data?.[0];
    if (row && n(row.price) != null) fallback = { price: Number(row.price), quotedAt: Date.parse(row.quoted_at) };
  }
  if (!quote && !fallback && bars.length === 0) return { analysis: null, notFound: true };

  const price = quote?.price ?? fallback?.price ?? (bars.length ? bars[bars.length - 1].c : null);
  const v = verdictR.data;
  const h = holdR.data;
  const lots = h ? Number(h.net_qty) / 1000 : 0;
  let holdingDecision: HoldingDecision | undefined;
  let holdingStop: number | null = null;
  const dataWarnings = [
    barsR.error ? '日線資料讀取失敗' : null,
    verdictR.error ? '盤中進場閘門讀取失敗' : null,
    holdR.error ? '持股資料讀取失敗' : null,
  ].filter((v): v is string => !!v);
  if (h && lots > 0) {
    try {
      const [advice, signals, dates] = await Promise.all([
        sb.from('v_holdings_advice').select('*').eq('symbol',symbol).maybeSingle(),
        sb.from('v_holdings_signals').select('signal_level').eq('symbol',symbol).maybeSingle(),
        holdingDates([symbol]),
      ]);
      if (advice.error || signals.error || !advice.data) throw new Error('holding analysis unavailable');
      const row=advice.data as HoldingEvidence;
      holdingStop=n(row.stop_loss_price);
      // Use the direct quote when available, with its own timestamp and provenance.
      const current = quote?.price != null ? {
        ...row, current_price:quote.price,
        pct_change: Number(h.avg_cost)>0 ? (quote.price/Number(h.avg_cost)-1)*100 : null,
        as_of_ts:quote.quotedAt ? new Date(quote.quotedAt).toISOString() : null,
        price_source:quote.priceIsMid?'twse_mis_mid':'twse_mis',
      } : row;
      holdingDecision=decideHolding(current,signals.data?.signal_level??null,dates[symbol]??null);
    } catch {
      holdingDecision={state:'unavailable',label:'分析受限',headline:'持股綜合分析讀取失敗',reasons:['暫不提供持股操作判斷，請更新資料。']};
    }
  }
  return {
    notFound: false,
    analysis: {
      symbol,
      name: mis.raw?.n ?? nameR.data?.name ?? null,
      fetchedAt: Date.now(),
      quote,
      quoteError: quote ? null : (mis.error ?? "MIS 無可用報價"),
      fallback,
      daily: dailyStats(bars),
      supply: price != null && bars.length ? supplyAbove(bars, price) : null,
      verdict: v ? {
        watchDate: String(v.watch_date), entryMin: n(v.entry_min), entryMax: n(v.entry_max),
        stopPrice: n(v.stop_price), state: String(v.state), reason: v.reason ?? null,
      } : null,
      holding: h && lots > 0 ? { lots, avgCost: Number(h.avg_cost) } : null,
      atrMultiple: n(setR.data?.value) ?? 2,
      holdingDecision, holdingStop, dataWarnings,
    },
  };
}
