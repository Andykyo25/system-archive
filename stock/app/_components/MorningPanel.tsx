import Link from "next/link";
import { EVENT_LABEL, fmtPct, pctColor } from "./Format";
import { GATE_THRESHOLD, INDUSTRY_SOURCE, SOURCE_META } from "./overseas-map";

// overseas_indicators 一列(原 OverseasWidget 的型別;該 widget 2026-07-11 改版移除,
// 型別收編於此 — MorningPanel gate 與 HoldingsIntelWidget 共用)
export interface OverseasRow {
  symbol: string;
  quoted_date: string;
  last_price: number | string | null;
  prev_close: number | string | null;
  change_pct: number | string | null;
}

// 今晨決策面板(dashboard 頂部結論層,2026-07-10 UI 優化第一塊)
//
// 設計:把「做一個決策要跨 4 頁」收斂成一屏三行 —
//   環境(regime 燈 + 持股對應海外源 gate)/ 持股狀態 chips / 今日機會摘要
// 下方 HoldingsIntelWidget(海外同業+新聞)、EntrySignalWidget(完整表)= 細節層;
// 此處只放結論,資料全部來自既有 view,無新增計算邏輯。
// Regime 分區 = U 型濾網產品化(原獨立 RegimeWidget 整併於此):
//   0050 近 61 筆(≈一季)報酬 <0 / ≥20% 兩端歷史有利、10-20% 地雷區。僅 12 季樣本。

export interface MorningHolding {
  symbol: string;
  name: string | null;
  industry: string | null;
  current_price: number | string | null;
  today_chg_pct: number | string | null;
  pct_change: number | string | null; // 持有報酬%
  signal_level: "healthy" | "caution" | "warning" | "alert" | null;
  stop_loss_price: number | string | null;
  rsi14: number | string | null;
  entry_zone: string | null;
  events: { type: string; date: string }[]; // 7 日內事件(法說會/除權息/股東會)
}

export interface MorningSignalPick {
  symbol: string;
  name: string | null;
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const LEVEL_META: Record<
  string,
  { label: string; dot: string; text: string }
> = {
  healthy: { label: "健康", dot: "bg-emerald-500", text: "text-emerald-300" },
  caution: { label: "注意", dot: "bg-yellow-500", text: "text-yellow-300" },
  warning: { label: "警示", dot: "bg-orange-500", text: "text-orange-300" },
  alert: { label: "危險", dot: "bg-red-500", text: "text-red-300" },
};

const ZONE_META: Record<string, { label: string; cls: string }> = {
  chase: { label: "追高區", cls: "bg-amber-900/40 text-amber-300" },
  neutral: { label: "中性", cls: "bg-zinc-800 text-zinc-400" },
  pullback: { label: "回檔區", cls: "bg-emerald-900/40 text-emerald-300" },
  broken: { label: "趨勢破壞", cls: "bg-red-900/40 text-red-300" },
};

function regimeZone(ret: number): { label: string; cls: string; note: string } {
  if (ret < 0)
    return { label: "歷史有利區(跌勢)", cls: "text-green-400", note: "季 alpha 歷史 +8.84(全勝)" };
  if (ret < 10)
    return { label: "中性區", cls: "text-zinc-300", note: "無顯著歷史傾向" };
  if (ret < 20)
    return { label: "⚠ 策略地雷區", cls: "text-orange-400", note: "季 alpha 歷史 −8.70(全敗):減碼/改 0050" };
  return { label: "歷史有利區(強漲)", cls: "text-green-400", note: "季 alpha 歷史 +3.76(全勝)" };
}

// 距停損緩衝:現價高於停損價多少 %(≤0 = 已破)
function stopBuffer(current: number | null, stop: number | null): {
  text: string;
  cls: string;
} | null {
  if (current == null || stop == null || current <= 0) return null;
  const buf = ((current - stop) / current) * 100;
  if (buf <= 0) return { text: "⛔ 已破停損", cls: "text-red-400 font-semibold" };
  const text = `距停損 ${buf.toFixed(1)}%`;
  if (buf < 5) return { text, cls: "text-red-400" };
  if (buf < 10) return { text, cls: "text-amber-400" };
  return { text, cls: "text-zinc-400" };
}

export function MorningPanel({
  regimeRet,
  overseasRows,
  holdings,
  signalCount,
  signalTop,
}: {
  regimeRet: number | null;
  overseasRows: OverseasRow[];
  holdings: MorningHolding[];
  signalCount: number;
  signalTop: MorningSignalPick[];
}) {
  // 持股對應海外源(僅已驗證映射,同 symbol 去重)
  const srcMap = new Map<
    string,
    { label: string; chg: number | null; industries: string[] }
  >();
  for (const h of holdings) {
    if (!h.industry) continue;
    const m = INDUSTRY_SOURCE[h.industry];
    if (!m?.verified) continue;
    const row = overseasRows.find((r) => r.symbol === m.src);
    const entry = srcMap.get(m.src) ?? {
      label: SOURCE_META[m.src]?.label ?? m.src,
      chg: row ? num(row.change_pct) : null,
      industries: [],
    };
    if (!entry.industries.includes(h.industry)) entry.industries.push(h.industry);
    srcMap.set(m.src, entry);
  }
  const gates = [...srcMap.entries()];

  const zone = regimeRet != null ? regimeZone(regimeRet) : null;

  return (
    <section className="rounded-2xl border border-line bg-surface-1 backdrop-blur divide-y divide-white/[0.06]">
      {/* 環境行:regime + 海外 gate */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          今晨決策
        </span>
        {zone && regimeRet != null ? (
          <>
            <span className="text-zinc-400">Regime</span>
            <span className="tabular-nums" title="0050 近 61 個交易日(≈一季)還原報酬">
              0050 近季 {regimeRet >= 0 ? "+" : ""}
              {regimeRet.toFixed(1)}%
            </span>
            <span className={`font-medium ${zone.cls}`} title={`${zone.note} · U 型濾網僅 12 季樣本,paper-track 驗真中`}>
              {zone.label}
            </span>
          </>
        ) : (
          <span className="text-zinc-500">Regime 資料不足</span>
        )}
        <span className="text-zinc-700">|</span>
        {gates.length === 0 ? (
          <span className="text-xs text-zinc-500">持股無已驗證海外對應源</span>
        ) : (
          gates.map(([src, g]) => {
            const hit = g.chg != null && g.chg <= GATE_THRESHOLD;
            return (
              <span
                key={src}
                className={`text-xs ${hit ? "rounded bg-red-900/40 px-1.5 py-0.5 font-medium text-red-300" : "text-zinc-400"}`}
                title={`${g.industries.join("/")} 持股的隔夜領先源(已驗證下檔不對稱);≤ ${GATE_THRESHOLD}% 當日勿加碼/低接`}
              >
                {hit ? "⛔ " : ""}
                {g.industries.join("/")}→{g.label}{" "}
                <span className={g.chg == null ? "" : pctColor(g.chg)}>
                  {g.chg == null ? "—" : fmtPct(g.chg)}
                </span>
                {hit ? " 今日勿進" : ""}
              </span>
            );
          })
        )}
      </div>

      {/* 持股行:每檔一列 chips */}
      <div className="px-4 py-2">
        {holdings.length === 0 ? (
          <p className="py-1 text-sm text-zinc-500">目前無持股</p>
        ) : (
          holdings.map((h) => {
            const level = h.signal_level ? LEVEL_META[h.signal_level] : null;
            const zoneMeta = h.entry_zone ? ZONE_META[h.entry_zone] : null;
            const price = num(h.current_price);
            const rsi = num(h.rsi14);
            const buf = stopBuffer(price, num(h.stop_loss_price));
            return (
              <div
                key={h.symbol}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1 text-sm"
              >
                <Link
                  href={`/stocks/${h.symbol}`}
                  className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
                >
                  {h.symbol}
                </Link>
                {h.name && <span className="text-zinc-300">{h.name}</span>}
                <span className="tabular-nums">
                  {price != null ? price.toLocaleString() : "—"}
                </span>
                <span className={`tabular-nums text-xs ${pctColor(h.today_chg_pct)}`}>
                  今日 {fmtPct(h.today_chg_pct)}
                </span>
                <span className={`tabular-nums text-xs ${pctColor(h.pct_change)}`}>
                  持有 {fmtPct(h.pct_change)}
                </span>
                {level && (
                  <span className={`inline-flex items-center gap-1 text-xs ${level.text}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${level.dot}`} />
                    {level.label}
                  </span>
                )}
                {buf && (
                  <span className={`tabular-nums text-xs ${buf.cls}`}>{buf.text}</span>
                )}
                {rsi != null && (
                  <span className="tabular-nums text-xs text-zinc-400">
                    RSI {rsi.toFixed(0)}
                  </span>
                )}
                {zoneMeta && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] ${zoneMeta.cls}`}
                    title="價位質量(資訊性,非買賣指令)"
                  >
                    {zoneMeta.label}
                  </span>
                )}
                {h.events.length > 0 && (
                  <span
                    className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[11px] text-amber-300"
                    title={h.events
                      .map((e) => `${EVENT_LABEL[e.type] ?? e.type} ${e.date}`)
                      .join("\n")}
                  >
                    📅 {EVENT_LABEL[h.events[0].type] ?? h.events[0].type}{" "}
                    {h.events[0].date.slice(5)}
                    {h.events.length > 1 ? ` +${h.events.length - 1}` : ""}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 機會行:進場訊號摘要 */}
      <div className="flex flex-wrap items-baseline gap-x-2 px-4 py-2 text-xs text-zinc-400">
        <span>
          今日進場訊號{" "}
          <span className="font-semibold text-zinc-200">{signalCount}</span> 檔
        </span>
        {signalTop.length > 0 && (
          <span className="text-zinc-500">
            {signalTop
              .map((s) => `${s.symbol}${s.name ? ` ${s.name}` : ""}`)
              .join("、")}
            {signalCount > signalTop.length ? " …" : ""}
          </span>
        )}
        <Link href="/rank" className="text-zinc-500 hover:text-zinc-300">
          看完整排名 →
        </Link>
      </div>
    </section>
  );
}
