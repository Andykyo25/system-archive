import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { unwrap } from "@/lib/db";
import { fmtMoney, fmtPct, pctColor } from "../_components/Format";

// 起漲點掃描(2026-08-06 改版,Andy「介面參考 winvest 四燈號」+「三頁太多,融合」)
// 三面向燈號:起漲 34 / 位置 33 / 動能 33 = 100。全市場約 1900 檔。
// 取代原 /rank(19 因子中長期選股)與 /swing(等回檔,與追突破方向相反)在側欄的位置。

export const dynamic = "force-dynamic";

interface Row {
  symbol: string;
  name: string | null;
  industry_category: string | null;
  trade_date: string;
  close: number | string | null;
  day_pct: number | string | null;
  volume_lots: number | string | null;
  ma20_gap_pct: number | string | null;
  ma20_slope_pct: number | string | null;
  high_20d: number | string | null;
  rsi14: number | string | null;
  ret_5d_pct: number | string | null;
  score_surge: number | null;
  score_position: number | null;
  score_momentum: number | null;
  score_total: number | null;
  passes_all: boolean | null;
  fgn_net_5d: number | string | null;
}

const n = (v: number | string | null | undefined): number | null => {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

const DIMS = [
  { key: "score_surge", max: 34, icon: "🚀", label: "起漲",
    detail: "今日漲幅 ≥7%(14) · 突破前20日高(12) · 量 ≥5000張(8)" },
  { key: "score_position", max: 33, icon: "📊", label: "位置",
    detail: "月線轉揚(13) · 乖離 <10%(12) · 站上月線(8) — 防追高" },
  { key: "score_momentum", max: 33, icon: "⚡", label: "動能",
    detail: "RSI 50~70(13) · MA5>MA20(12) · 5日報酬 >0(8)" },
] as const;

function tone(score: number, max: number): string {
  const r = score / max;
  if (r >= 0.8) return "bg-green-900/40 text-green-300 ring-green-800/40";
  if (r >= 0.5) return "bg-amber-900/40 text-amber-300 ring-amber-800/40";
  return "bg-red-900/30 text-red-300 ring-red-900/40";
}

function verdict(total: number): { label: string; cls: string } {
  if (total >= 85) return { label: "起漲確立", cls: "text-green-300" };
  if (total >= 70) return { label: "型態成形", cls: "text-amber-300" };
  if (total >= 55) return { label: "訊號偏弱", cls: "text-zinc-400" };
  return { label: "不成型", cls: "text-zinc-500" };
}

// 一句話看懂:只陳述已成立的事實,不下買賣結論
function oneLiner(r: Row): string {
  const parts: string[] = [];
  const day = n(r.day_pct), gap = n(r.ma20_gap_pct), slope = n(r.ma20_slope_pct);
  const rsi = n(r.rsi14), vol = n(r.volume_lots), close = n(r.close), high = n(r.high_20d);

  if (day != null && day >= 9.5) parts.push("今日漲停");
  else if (day != null && day >= 7) parts.push(`今日 +${day.toFixed(1)}%`);
  else if (day != null) parts.push(`今日 +${day.toFixed(1)}%(未達 7%)`);

  if (close != null && high != null) {
    parts.push(close > high ? "已突破前 20 日高" : `距前高還差 ${(high - close).toFixed(1)} 元`);
  }
  if (vol != null) parts.push(vol >= 5000 ? `量 ${vol.toLocaleString()} 張充足` : `量僅 ${vol.toLocaleString()} 張`);
  if (slope != null) parts.push(slope > 0 ? "月線轉揚" : "月線尚未轉揚");
  if (gap != null && gap >= 15) parts.push(`乖離 ${gap.toFixed(1)}% 偏高`);
  if (rsi != null && rsi > 80) parts.push(`RSI ${rsi.toFixed(0)} 過熱`);
  else if (rsi != null && rsi < 30) parts.push(`RSI ${rsi.toFixed(0)} 過冷`);

  return parts.join("、") + "。";
}

function ScoreRow({ r }: { r: Row }) {
  const total = r.score_total ?? 0;
  const v = verdict(total);
  const fgn = n(r.fgn_net_5d);
  return (
    <div className="border-t border-line-soft px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Link
          href={`/stocks/${r.symbol}`}
          className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
        >
          {r.symbol}
        </Link>
        <span className="font-medium text-zinc-200">{r.name ?? "—"}</span>
        <span className="text-[11px] text-zinc-600">{r.industry_category ?? ""}</span>

        <span className="ml-auto flex items-center gap-3 tabular-nums">
          <span className="text-zinc-300">
            {fmtMoney(r.close, n(r.close) != null && n(r.close)! < 100 ? 2 : 0)}
          </span>
          <span className={`w-16 text-right ${pctColor(r.day_pct)}`}>{fmtPct(r.day_pct)}</span>
          <span className="w-20 text-right text-xs text-zinc-500">
            {r.volume_lots != null ? `${Number(r.volume_lots).toLocaleString()} 張` : "—"}
          </span>
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {DIMS.map((d) => {
          const s = (r[d.key] as number | null) ?? 0;
          return (
            <span
              key={d.key}
              title={`${d.label} ${s}/${d.max} — ${d.detail}`}
              className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs ring-1 ring-inset ${tone(s, d.max)}`}
            >
              <span aria-hidden>{d.icon}</span>
              <span className="font-medium">{d.label}</span>
              <span className="tabular-nums opacity-80">{s}/{d.max}</span>
            </span>
          );
        })}
        <span className="ml-auto flex items-baseline gap-2">
          {fgn != null && (
            <span
              className="rounded bg-sky-950/50 px-1.5 py-0.5 text-[10px] text-sky-300"
              title="外資近 5 日累計買賣超(僅約 6% 標的有籌碼資料,不計入評分)"
            >
              外資 {fgn >= 0 ? "+" : ""}{Math.round(fgn / 1000).toLocaleString()} 張
            </span>
          )}
          <span className={`text-sm font-semibold ${v.cls}`}>{v.label}</span>
          <span className="tabular-nums text-lg font-bold text-zinc-100">{total}</span>
          <span className="text-xs text-zinc-600">/100</span>
        </span>
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{oneLiner(r)}</p>
    </div>
  );
}

export default async function ScanPage() {
  const sb = createClient();
  const [listR, totalR] = await Promise.all([
    sb.from("v_breakout_scan").select("*").gte("score_total", 80).limit(25),
    sb.from("v_breakout_scan").select("symbol", { count: "exact", head: true }),
  ]);

  const rows = (unwrap(listR, "v_breakout_scan") as Row[] | null) ?? [];
  const scanned = totalR.count ?? null;
  const passed = rows.filter((r) => r.passes_all === true);
  const near = rows.filter((r) => r.passes_all !== true);
  const scanDate = rows[0]?.trade_date ?? null;
  // v_breakout_scan 是即時 view(force-dynamic),每次開頁都重算 → 掃描時間就是本次 render。
  // 與 scanDate(資料截至哪一天收盤)並列才看得出新鮮度:兩者差太多 = 收料沒跟上。
  const scannedAt = new Date().toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <div className="space-y-5">
      <header className="rounded-2xl border border-line bg-surface-1 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-semibold">起漲掃描</h1>
          <span
            className="text-xs text-zinc-500"
            title="資料日 = 掃描用的收盤資料屬於哪個交易日;掃描時間 = 本頁這次重算的時間(每次開頁即時重算)。兩者差距過大代表收料沒跟上。"
          >
            資料 {scanDate ?? "—"} 收盤 · 全市場 {scanned ?? "—"} 檔 ·{" "}
            <span className="text-zinc-400">掃描於 {scannedAt}</span>
          </span>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          🚀 起漲 34 · 📊 位置 33 · ⚡ 動能 33 = 100 分（滑過燈號看門檻）。
          <span className="text-zinc-600">全過五條件者標 ✓；候選產生器，非買訊。</span>
        </p>
      </header>

      {passed.length > 0 ? (
        <section className="overflow-hidden rounded-2xl border border-line bg-surface-1">
          <div className="flex items-baseline gap-2 border-b border-line px-3 py-2">
            <h2 className="text-sm font-medium text-green-300">✓ 五條件全過</h2>
            <span className="text-xs text-zinc-600">({passed.length})</span>
          </div>
          {passed.map((r) => (
            <ScoreRow key={r.symbol} r={r} />
          ))}
        </section>
      ) : (
        <p className="rounded-2xl border border-line bg-surface-1 px-4 py-5 text-center text-sm text-zinc-500">
          今天沒有五條件全過的標的
          <span className="ml-1 text-zinc-600">（歷史約 43% 交易日會有，平均 2.2 檔）</span>
        </p>
      )}

      {near.length > 0 && (
        <details className="overflow-hidden rounded-2xl border border-line bg-surface-1">
          <summary className="cursor-pointer select-none px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">
            高分候選（80 分以上，未全過五條件）
            <span className="ml-1 text-xs text-zinc-600">({near.length})</span>
          </summary>
          {near.map((r) => (
            <ScoreRow key={r.symbol} r={r} />
          ))}
        </details>
      )}

      <p className="px-1 text-[11px] leading-relaxed text-zinc-600">
        盤後資料（即時報價無成交量，量能條件盤中無法判斷）。
        124 次觸發回顧：進場後 5 日超額 −0.81%、勝率 42.7%，樣本 3.5 個月不足以斷言有效或無效。
      </p>
    </div>
  );
}
