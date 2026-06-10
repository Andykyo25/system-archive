// 海外隔夜領先快照(2026-06-10)— 走 B 資訊呈現,read-only。
// 資料:overseas_indicators(11 源,盤前 06:30/08:30 Taipei cron 抓 Yahoo v8)。
// 領先性圖譜(2026-06-02~04 全 universe 掃描驗證,n≈470 intraday corr):
//   - 記憶體 → MU(華邦電/南亞科/群聯/旺宏 0.13-0.19,系統性成立)✅ 已驗證
//   - 台積電鏈 → TSM ADR(本尊 0.29,鏈上 0.13-0.17)✅ 已驗證
//   - 金融/傳產 → 海外領先無效(負相關蹺蹺板)→ 不映射
//   - 不對稱:下檔警示強(MU<-2% → 華邦電隔日 -0.93%)、上檔買訊弱(勝率 48%)
//   → 警示只做下檔,上檔明示「別當買訊」。強度 0.1-0.3 = 風險參考,非交易訊號。
// 階段 2(盤前推播)維持 Andy 暫緩;本 widget 僅 dashboard 呈現已有資料。

import { fmtPct, pctColor } from "./Format";

export interface OverseasRow {
  symbol: string;
  quoted_date: string;
  last_price: number | string;
  prev_close: number | string | null;
  change_pct: number | string | null;
}

// 顯示名 + 分組(指數 / ADR / 產業龍頭代理)
const SOURCE_META: Record<
  string,
  { label: string; group: "index" | "adr" | "proxy"; neutral?: boolean }
> = {
  "^SOX": { label: "費半", group: "index" },
  "^IXIC": { label: "那斯達克", group: "index" },
  "NQ=F": { label: "那指期", group: "index" },
  "^VIX": { label: "VIX", group: "index", neutral: true }, // 波動率漲跌無多空色,僅數值
  TSM: { label: "台積ADR", group: "adr" },
  UMC: { label: "聯電ADR", group: "adr" },
  MU: { label: "美光", group: "proxy" },
  NVDA: { label: "輝達", group: "proxy" },
  AAPL: { label: "蘋果", group: "proxy" },
  AVGO: { label: "博通", group: "proxy" },
  AMD: { label: "超微", group: "proxy" },
};

const GROUP_ORDER: Array<"index" | "adr" | "proxy"> = ["index", "adr", "proxy"];
const GROUP_LABEL = { index: "指數", adr: "ADR", proxy: "產業龍頭" } as const;

// 產業 → 海外對應源。verified = 領先性圖譜實證過(只有實證的才觸發下檔警示)。
// 金融/航運/車用電動車/被動元件/面板/生技:掃描驗證為無效 → 不映射。
const INDUSTRY_SOURCE: Record<
  string,
  { src: string; verified: boolean; downNote: string }
> = {
  記憶體: { src: "MU", verified: true, downNote: "歷史隔日均約 -0.9%" },
  IC設計: { src: "TSM", verified: true, downNote: "台積電鏈隔日偏弱" },
  半導體封測: { src: "TSM", verified: true, downNote: "台積電鏈隔日偏弱" },
  AI伺服器: { src: "NVDA", verified: false, downNote: "" },
};

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function OverseasWidget({
  rows,
  holdings,
}: {
  rows: OverseasRow[];
  /** 持股 symbol → industry(industry_stocks 分類,可 null) */
  holdings: Array<{ symbol: string; industry: string | null }>;
}) {
  if (rows.length === 0) return null;

  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));

  // 持股對應源:industry → src(高亮 + 下檔警示)
  const holdingSources = new Map<
    string,
    { holdingSymbols: string[]; verified: boolean; downNote: string }
  >();
  for (const h of holdings) {
    const m = h.industry ? INDUSTRY_SOURCE[h.industry] : undefined;
    if (!m) continue;
    const cur = holdingSources.get(m.src) ?? {
      holdingSymbols: [],
      verified: m.verified,
      downNote: m.downNote,
    };
    cur.holdingSymbols.push(h.symbol);
    holdingSources.set(m.src, cur);
  }

  // 下檔警示(只對 verified 對應源,且 ≤ -2%);上檔 ≥ +2% 提示「別當買訊」
  const alerts: Array<{ kind: "down" | "up"; text: string }> = [];
  for (const [src, info] of holdingSources) {
    const r = bySymbol.get(src);
    const chg = num(r?.change_pct);
    if (!r || chg == null || !info.verified) continue;
    const label = SOURCE_META[src]?.label ?? src;
    const held = info.holdingSymbols.join("/");
    if (chg <= -2) {
      alerts.push({
        kind: "down",
        text: `${label} 隔夜 ${fmtPct(chg)} — 持股 ${held} 開盤偏弱(${info.downNote}),勿急著低接`,
      });
    } else if (chg >= 2) {
      alerts.push({
        kind: "up",
        text: `${label} 隔夜 ${fmtPct(chg)} — 上檔領先弱(勝率僅 48%),別當買訊`,
      });
    }
  }

  // 各源最新 quoted_date 不同(美股=前一交易日、期貨=即時),取眾數外顯示個別日期
  const latestDate = rows.reduce(
    (acc, r) => (r.quoted_date > acc ? r.quoted_date : acc),
    "",
  );

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">
          海外隔夜領先{" "}
          <span className="text-sm font-normal text-zinc-500">
            (盤前風險參考 · 領先強度 0.1-0.3,非買賣訊號)
          </span>
        </h2>
      </div>

      {alerts.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {alerts.map((a, i) => (
            <div
              key={i}
              className={`rounded-md border px-3 py-2 text-sm ${
                a.kind === "down"
                  ? "border-red-800 bg-red-950/50 text-red-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400"
              }`}
            >
              {a.kind === "down" ? "⚠ " : "ℹ "}
              {a.text}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
        {GROUP_ORDER.map((g) => {
          const items = rows
            .filter((r) => SOURCE_META[r.symbol]?.group === g)
            .sort((a, b) => a.symbol.localeCompare(b.symbol));
          if (items.length === 0) return null;
          return (
            <div key={g} className="flex items-center gap-x-4">
              <span className="text-[10px] uppercase tracking-wide text-zinc-600">
                {GROUP_LABEL[g]}
              </span>
              {items.map((r) => {
                const meta = SOURCE_META[r.symbol];
                const chg = num(r.change_pct);
                const held = holdingSources.get(r.symbol);
                const stale = r.quoted_date < latestDate;
                return (
                  <div
                    key={r.symbol}
                    className={`inline-flex flex-col items-center ${
                      held
                        ? "rounded-md bg-zinc-800 px-2 py-0.5 ring-1 ring-amber-500/60"
                        : ""
                    }`}
                    title={`${r.symbol} · ${r.quoted_date}${held ? ` · 持股對應源(${held.holdingSymbols.join("/")})` : ""}`}
                  >
                    <span className="text-xs text-zinc-400">
                      {meta?.label ?? r.symbol}
                      {held && <span className="ml-0.5 text-amber-400">★</span>}
                    </span>
                    <span
                      className={`text-sm font-medium tabular-nums ${
                        meta?.neutral ? "text-zinc-300" : pctColor(chg)
                      }`}
                    >
                      {chg != null ? fmtPct(chg) : "—"}
                    </span>
                    {stale && (
                      <span className="text-[9px] leading-tight text-zinc-600">
                        {r.quoted_date.slice(5)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
