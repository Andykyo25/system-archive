import { fmtPct, pctColor } from "./Format";
import {
  GATE_THRESHOLD,
  GENERIC_INTEL,
  INDUSTRY_INTEL,
  INDUSTRY_SOURCE,
  SOURCE_META,
} from "./overseas-map";
import type { OverseasRow } from "./MorningPanel";
import { summarizeNews, type NewsSentimentSummary } from "./news-lexicon";

// 晨間持股情報(2026-07-11,取代 OverseasWidget):
// 每檔持股 → 海外同業報價(美股隔夜收盤 + 韓股盤中快照)+ 規則式對齊判讀
// + 新聞關鍵字計分 + 「今日建議」規則樹 + 台/國際新聞連結。
// 全部是純規則彙總(漲跌家數 / 標題關鍵字 / 紀律價位),非語意理解、非投資指令;
// 新聞一進 DB(台 6h / 國際 07:50 cron)下次 render 即反映(600s 快取)。

export interface IntelHolding {
  symbol: string;
  name: string | null;
  industry: string | null;
  current_price: number | string | null;
  stop_loss_price: number | string | null;
  add_position_price: number | string | null;
  entry_zone: string | null;
}

export interface IntelNewsRow {
  symbol: string; // 台股代號(台新聞)或 topic tag(國際新聞,如 MU / 005930.KS)
  title: string;
  url: string;
  published_at: string | null;
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function taipeiToday(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function newsAge(publishedAt: string | null): string {
  if (!publishedAt) return "";
  const t = new Date(publishedAt).getTime();
  if (!Number.isFinite(t)) return "";
  const h = (Date.now() - t) / 3600_000;
  if (h < 1) return "<1h";
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

// 規則式判讀:同業(排除 VIX 等中性源)漲跌家數 → 偏多/偏空/分歧 + verified gate
interface QuoteSynth {
  text: string;
  cls: string;
  dir: "bull" | "bear" | "mixed" | "flat" | "na";
  gateHit: boolean;
}

function synthesize(
  quotes: { symbol: string; chg: number | null }[],
  industry: string | null,
): QuoteSynth {
  const scored = quotes.filter(
    (q) => q.chg != null && !SOURCE_META[q.symbol]?.neutral,
  );
  if (scored.length === 0)
    return { text: "海外同業資料不足", cls: "text-zinc-500", dir: "na", gateHit: false };
  const up = scored.filter((q) => (q.chg ?? 0) > 0.3).length;
  const down = scored.filter((q) => (q.chg ?? 0) < -0.3).length;

  // 已驗證 gate:產業對應源大跌(僅 verified 源觸發,例:記憶體→美光)
  const src = industry ? INDUSTRY_SOURCE[industry] : undefined;
  if (src?.verified) {
    const g = quotes.find((q) => q.symbol === src.src);
    if (g?.chg != null && g.chg <= GATE_THRESHOLD) {
      return {
        text: `⛔ ${SOURCE_META[src.src]?.label ?? src.src} 大跌 ${fmtPct(g.chg)}(已驗證領先源,${src.downNote})`,
        cls: "text-red-300 font-medium",
        dir: "bear",
        gateHit: true,
      };
    }
  }
  if (up > 0 && down === 0)
    return { text: `海外同業偏多(${up}/${scored.length} 上漲)`, cls: "text-red-300", dir: "bull", gateHit: false };
  if (down > 0 && up === 0)
    return { text: `海外同業偏空(${down}/${scored.length} 下跌)`, cls: "text-green-300", dir: "bear", gateHit: false };
  if (up > 0 && down > 0)
    return { text: `海外同業分歧(${up} 漲 ${down} 跌)`, cls: "text-zinc-400", dir: "mixed", gateHit: false };
  return { text: "海外同業持平", cls: "text-zinc-400", dir: "flat", gateHit: false };
}

// 今日建議規則樹:防守優先(停損/gate/regime)→ 外部訊號 → 價位區。
// 純規則彙總,非投資指令;每條都引用紀律價位讓行動可執行。
function deriveTodayAdvice(
  h: IntelHolding,
  synth: QuoteSynth,
  news: NewsSentimentSummary,
  regimeRet: number | null,
): { text: string; cls: string } {
  const price = num(h.current_price);
  const stop = num(h.stop_loss_price);
  const add = num(h.add_position_price);
  const stopStr = stop != null ? stop.toLocaleString() : "—";

  if (price != null && stop != null && price <= stop)
    return { text: `⛔ 已破停損(${stopStr}):依紀律出場,別凹單`, cls: "text-red-300 font-semibold" };
  if (price != null && stop != null && ((price - stop) / price) * 100 < 5)
    return { text: `⚠ 距停損 <5%(${stopStr}):今日首要是防守,不加碼`, cls: "text-red-300" };
  if (synth.gateHit)
    return { text: `⛔ 領先源大跌:今日勿加碼/勿低接,守停損 ${stopStr}`, cls: "text-red-300" };
  if (regimeRet != null && regimeRet >= 10 && regimeRet < 20)
    return { text: `⚠ Regime 地雷區(0050 近季 +${regimeRet.toFixed(1)}%,歷史全敗區):傾向減碼、不加碼`, cls: "text-orange-300" };
  if (synth.dir === "bear" || news.dir === "bear")
    return { text: `外部訊號偏空(${synth.dir === "bear" ? "海外同業" : "新聞關鍵字"}):今日不加碼,守停損 ${stopStr}`, cls: "text-green-300" };
  // 走到這裡 news.dir 必非 bear(上一條已 early-return),不需重複判斷
  if (h.entry_zone === "pullback" && synth.dir === "bull")
    return {
      text: `✓ 回檔區 + 外部正向 = 你的贏單型態:可依部位紀律評估加碼(加碼價 ${add != null ? add.toLocaleString() : "—"},張數看下單頁 sizing)`,
      cls: "text-red-300",
    };
  if (h.entry_zone === "chase")
    return { text: `現價在追高區:想加碼掛回 MA20 附近限價,勿市價追;守停損 ${stopStr}`, cls: "text-amber-300" };
  return {
    text: `訊號中性/分歧:持有不動,紀律價位 停損 ${stopStr}${add != null ? ` / 加碼 ${add.toLocaleString()}` : ""}`,
    cls: "text-zinc-300",
  };
}

export function HoldingsIntelWidget({
  holdings,
  overseasRows,
  twNews,
  intlNews,
  regimeRet,
}: {
  holdings: IntelHolding[];
  overseasRows: OverseasRow[];
  twNews: IntelNewsRow[];
  intlNews: IntelNewsRow[];
  regimeRet: number | null;
}) {
  if (holdings.length === 0) return null;
  const today = taipeiToday();
  const quoteMap = new Map<string, OverseasRow>();
  for (const r of overseasRows) quoteMap.set(r.symbol, r);

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">晨間持股情報</h2>
      <div className="space-y-3">
        {holdings.map((h) => {
          const intel =
            (h.industry && INDUSTRY_INTEL[h.industry]) || GENERIC_INTEL;
          const quotes = intel.quotes.map((sym) => {
            const row = quoteMap.get(sym);
            return {
              symbol: sym,
              chg: row ? num(row.change_pct) : null,
              live:
                SOURCE_META[sym]?.group === "kr" &&
                row?.quoted_date === today,
            };
          });
          const synth = synthesize(quotes, h.industry);
          const twAll = twNews.filter((n) => n.symbol === h.symbol);
          const intlAll = intlNews.filter((n) => intel.news.includes(n.symbol));
          const tw = twAll.slice(0, 4);
          const intl = intlAll.slice(0, 4);
          // 新聞關鍵字計分:用該持股 48h 內全部標題(台+國際),顯示只取前 4
          const news = summarizeNews([...twAll, ...intlAll].map((n) => n.title));
          const advice = deriveTodayAdvice(h, synth, news, regimeRet);
          const newsChip =
            news.total === 0
              ? null
              : {
                  text: `新聞 利多${news.bullTitles}/利空${news.bearTitles}(近48h ${news.total} 則)`,
                  cls:
                    news.dir === "bull"
                      ? "text-red-300"
                      : news.dir === "bear"
                        ? "text-green-300"
                        : "text-zinc-400",
                  tip: `關鍵字命中 ${news.scored}/${news.total} 則;命中詞:${news.sampleHits.join("、") || "—"}(標題級關鍵字統計,非語意理解)`,
                };
          return (
            <div
              key={h.symbol}
              className="rounded-2xl border border-line bg-surface-1 px-4 py-3"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-blue-400">{h.symbol}</span>
                {h.name && <span className="text-zinc-200">{h.name}</span>}
                {h.industry && (
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">
                    {h.industry}
                  </span>
                )}
                {quotes.map((q) => (
                  <span key={q.symbol} className="text-xs tabular-nums">
                    <span className="text-zinc-400">
                      {SOURCE_META[q.symbol]?.label ?? q.symbol}
                    </span>{" "}
                    <span className={pctColor(q.chg)}>
                      {q.chg == null ? "—" : fmtPct(q.chg)}
                    </span>
                    {q.live && (
                      <span className="ml-0.5 text-[10px] text-amber-400" title="韓股盤中(08:30 快照)">
                        開盤中
                      </span>
                    )}
                  </span>
                ))}
              </div>
              <p className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs">
                <span className={synth.cls}>{synth.text}</span>
                {newsChip && (
                  <span className={`cursor-help ${newsChip.cls}`} title={newsChip.tip}>
                    {newsChip.text}
                  </span>
                )}
              </p>
              <p className={`mt-1 rounded bg-surface-raised px-2 py-1 text-xs ${advice.cls}`}>
                <span className="mr-1 text-[10px] uppercase tracking-wide text-zinc-500">
                  今日建議
                </span>
                {advice.text}
              </p>
              {(tw.length > 0 || intl.length > 0) && (
                <div className="mt-2 grid gap-x-6 gap-y-1 text-xs md:grid-cols-2">
                  <div className="space-y-1">
                    {tw.length > 0 && (
                      <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                        台灣新聞
                      </p>
                    )}
                    {tw.map((n) => (
                      <a
                        key={n.url}
                        href={n.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate text-zinc-300 hover:text-blue-300 hover:underline"
                        title={n.title}
                      >
                        {n.title}
                        <span className="ml-1 text-zinc-600">{newsAge(n.published_at)}</span>
                      </a>
                    ))}
                  </div>
                  <div className="space-y-1">
                    {intl.length > 0 && (
                      <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                        國際新聞
                      </p>
                    )}
                    {intl.map((n) => (
                      <a
                        key={n.url}
                        href={n.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate text-zinc-300 hover:text-blue-300 hover:underline"
                        title={n.title}
                      >
                        <span className="text-zinc-500">
                          [{SOURCE_META[n.symbol]?.label ?? n.symbol}]
                        </span>{" "}
                        {n.title}
                        <span className="ml-1 text-zinc-600">{newsAge(n.published_at)}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
