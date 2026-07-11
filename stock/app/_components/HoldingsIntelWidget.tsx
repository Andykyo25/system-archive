import { fmtPct, pctColor } from "./Format";
import {
  GATE_THRESHOLD,
  GENERIC_INTEL,
  INDUSTRY_INTEL,
  INDUSTRY_SOURCE,
  SOURCE_META,
} from "./overseas-map";
import type { OverseasRow } from "./MorningPanel";

// 晨間持股情報(2026-07-11,取代 OverseasWidget):
// 每檔持股 → 海外同業報價(美股隔夜收盤 + 韓股盤中快照)+ 規則式對齊判讀 + 台/國際新聞連結。
// 判讀是純規則(同業漲跌家數 + 已驗證 MU gate),非預測;新聞連結開新分頁。
// 資料:overseas_indicators(cron 06:30/08:30 Taipei)+ stock_news(台 6h / 國際 07:50)。

export interface IntelHolding {
  symbol: string;
  name: string | null;
  industry: string | null;
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

// 規則式判讀:同業(排除 VIX / 指數以外皆計)漲跌家數 → 偏多/偏空/分歧
function synthesize(
  quotes: { symbol: string; chg: number | null }[],
  industry: string | null,
): { text: string; cls: string } {
  const scored = quotes.filter(
    (q) => q.chg != null && !SOURCE_META[q.symbol]?.neutral,
  );
  if (scored.length === 0)
    return { text: "海外同業資料不足", cls: "text-zinc-500" };
  const up = scored.filter((q) => (q.chg ?? 0) > 0.3).length;
  const down = scored.filter((q) => (q.chg ?? 0) < -0.3).length;

  // 已驗證 gate:產業對應源大跌(僅 verified 源觸發,例:記憶體→美光)
  const src = industry ? INDUSTRY_SOURCE[industry] : undefined;
  if (src?.verified) {
    const g = quotes.find((q) => q.symbol === src.src);
    if (g?.chg != null && g.chg <= GATE_THRESHOLD) {
      return {
        text: `⛔ ${SOURCE_META[src.src]?.label ?? src.src} 大跌 ${fmtPct(g.chg)}(已驗證領先源,${src.downNote})— 今日勿加碼/低接`,
        cls: "text-red-300 font-medium",
      };
    }
  }
  if (up > 0 && down === 0)
    return { text: `海外同業偏多(${up}/${scored.length} 上漲)`, cls: "text-red-300" };
  if (down > 0 && up === 0)
    return { text: `海外同業偏空(${down}/${scored.length} 下跌)`, cls: "text-green-300" };
  if (up > 0 && down > 0)
    return { text: `海外同業分歧(${up} 漲 ${down} 跌)— 別把單一同業當訊號`, cls: "text-zinc-400" };
  return { text: "海外同業持平", cls: "text-zinc-400" };
}

export function HoldingsIntelWidget({
  holdings,
  overseasRows,
  twNews,
  intlNews,
}: {
  holdings: IntelHolding[];
  overseasRows: OverseasRow[];
  twNews: IntelNewsRow[];
  intlNews: IntelNewsRow[];
}) {
  if (holdings.length === 0) return null;
  const today = taipeiToday();
  const quoteMap = new Map<string, OverseasRow>();
  for (const r of overseasRows) quoteMap.set(r.symbol, r);

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">晨間持股情報</h2>
        <span className="text-xs text-zinc-500">
          美股 = 隔夜收盤 · 韓股 = 盤中快照 · 新聞連結開新分頁
        </span>
      </div>
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
          const tw = twNews.filter((n) => n.symbol === h.symbol).slice(0, 4);
          const intl = intlNews
            .filter((n) => intel.news.includes(n.symbol))
            .slice(0, 4);
          return (
            <div
              key={h.symbol}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3"
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
              <p className={`mt-1 text-xs ${synth.cls}`}>{synth.text}</p>
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
      <p className="mt-2 text-xs text-zinc-500">
        判讀為純規則(同業漲跌家數;僅「記憶體→美光」等已驗證領先源觸發 ⛔ gate,韓股為資訊性對照未經 lead-lag 驗證)。
        台灣新聞每 6 小時、國際新聞每日 07:50 更新(Google News)。
      </p>
    </section>
  );
}
