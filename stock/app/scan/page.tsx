import { TableShell, THead } from "@/app/_components/ui";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { unwrap } from "@/lib/db";
import { fmtMoney, fmtPct, pctColor } from "../_components/Format";

// 起漲點掃描(2026-08-06,Andy「排行只是把已經漲的列出來,我抓不到起漲點」)
// 五條件:漲幅>=7% · 量>5000張 · 股價>=20 · 突破前20日高+月線轉揚+乖離<15% · 排除傳產金融
// 池子 = 全市場 price_daily(約 1900 檔),不是既有排行的 137 檔題材股。
//
// 定位:候選產生器**非買訊**。初步回顧(124 次觸發,2026-04~07)5 日超額 -0.81pp、
// 勝率 42.7%,樣本 3.5 個月單一 regime,不足以斷言有效或無效(lessons L57/L60)。
// 盤後限定:即時報價沒有成交量,條件② 盤中無法判斷。

export const dynamic = "force-dynamic";

interface ScanRow {
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
  f_surge: boolean | null;
  f_volume: boolean | null;
  f_price: boolean | null;
  f_breakout: boolean | null;
  f_ma20_up: boolean | null;
  f_not_extended: boolean | null;
  conditions_met: number | null;
  passes_all: boolean | null;
}

const COND_LABELS: { key: keyof ScanRow; label: string; title: string }[] = [
  { key: "f_surge", label: "漲", title: "當日漲幅 >= 7%" },
  { key: "f_volume", label: "量", title: "成交 > 5000 張" },
  { key: "f_price", label: "價", title: "股價 >= 20 元(排除雞蛋水餃股)" },
  { key: "f_breakout", label: "破", title: "收盤突破前 20 日最高(跨出盤整區)" },
  { key: "f_ma20_up", label: "月", title: "站上月線且月線轉揚" },
  { key: "f_not_extended", label: "乖", title: "距月線乖離 < 15%(還沒飆過)" },
];

function Flags({ row }: { row: ScanRow }) {
  return (
    <span className="inline-flex gap-1">
      {COND_LABELS.map((c) => {
        const ok = row[c.key] === true;
        return (
          <span
            key={c.key as string}
            title={`${c.title}${ok ? "" : " — 未滿足"}`}
            className={`grid h-5 w-5 place-items-center rounded text-[10px] font-medium ${
              ok
                ? "bg-green-900/40 text-green-300"
                : "bg-zinc-800 text-zinc-600 line-through"
            }`}
          >
            {c.label}
          </span>
        );
      })}
    </span>
  );
}

function missingLabels(row: ScanRow): string {
  return COND_LABELS.filter((c) => row[c.key] !== true)
    .map((c) => c.title.split("(")[0])
    .join("、");
}

function ScanTable({ rows }: { rows: ScanRow[] }) {
  return (
    <TableShell>
      <table className="w-full text-sm">
        <THead>
          <tr>
            <th className="px-3 py-2">股號</th>
            <th className="px-3 py-2">名稱</th>
            <th className="px-3 py-2">產業</th>
            <th className="px-3 py-2 text-right">收盤</th>
            <th className="px-3 py-2 text-right">漲幅</th>
            <th className="px-3 py-2 text-right" title="成交張數">量(張)</th>
            <th className="px-3 py-2 text-right" title="前 20 日最高;收盤要高過它才算突破">
              前高
            </th>
            <th className="px-3 py-2 text-right" title="現價距月線乖離">距月線</th>
            <th className="px-3 py-2 text-right" title="月線 5 日斜率,正值 = 轉揚">月線斜率</th>
            <th className="px-3 py-2">條件</th>
          </tr>
        </THead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} className="border-t border-line-soft">
              <td className="px-3 py-2 font-mono">
                <Link
                  href={`/stocks/${r.symbol}`}
                  className="text-blue-400 hover:text-blue-300 hover:underline"
                >
                  {r.symbol}
                </Link>
              </td>
              <td className="px-3 py-2 text-zinc-300">{r.name ?? "—"}</td>
              <td className="px-3 py-2 text-xs text-zinc-500">{r.industry_category ?? "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {fmtMoney(r.close, r.close != null && Number(r.close) < 100 ? 2 : 0)}
              </td>
              <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.day_pct)}`}>
                {fmtPct(r.day_pct)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                {r.volume_lots != null ? Number(r.volume_lots).toLocaleString() : "—"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                {fmtMoney(r.high_20d, r.high_20d != null && Number(r.high_20d) < 100 ? 2 : 0)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                {fmtPct(r.ma20_gap_pct)}
              </td>
              <td
                className={`px-3 py-2 text-right tabular-nums ${
                  r.ma20_slope_pct != null && Number(r.ma20_slope_pct) > 0
                    ? "text-green-400"
                    : "text-zinc-500"
                }`}
              >
                {fmtPct(r.ma20_slope_pct)}
              </td>
              <td className="px-3 py-2">
                <Flags row={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableShell>
  );
}

export default async function ScanPage() {
  const sb = createClient();
  const [nearR, totalR] = await Promise.all([
    sb.from("v_breakout_scan").select("*").gte("conditions_met", 5),
    sb.from("v_breakout_scan").select("symbol", { count: "exact", head: true }),
  ]);

  const rows = (unwrap(nearR, "v_breakout_scan") as ScanRow[] | null) ?? [];
  const scanned = totalR.count ?? null;

  const passed = rows.filter((r) => r.passes_all === true);
  const near = rows.filter((r) => r.passes_all !== true);
  const scanDate = rows[0]?.trade_date ?? null;

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-line bg-surface-1 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-semibold">起漲點掃描 ({passed.length})</h1>
          <span className="text-sm text-zinc-500">
            {scanDate ? `${scanDate} 收盤` : "—"} · 掃描 {scanned ?? "—"} 檔
          </span>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          條件:漲幅 ≥7% · 成交 &gt;5000 張 · 股價 ≥20 元 · 突破前 20 日高 + 月線轉揚 + 乖離
          &lt;15% · 排除傳產/金融。池子為<b>全市場</b>(非排行的題材股名單)。
        </p>
        <p className="mt-2 rounded-lg bg-amber-950/30 px-3 py-2 text-xs text-amber-200/80">
          ⚠ <b>候選產生器,非買訊。</b>初步回顧(2026-04~07、124 次觸發):進場後 5 日超額報酬
          <b> −0.81%</b>、勝率 <b>42.7%</b> —— 現有樣本<b>沒有</b>顯示這組條件能賺錢。
          但樣本僅 3.5 個月、單一行情段,也不足以斷言它無效。當成「把該看的標的撈出來」的工具,
          不要當成訊號照單全收。
        </p>
        <p className="mt-1 text-[11px] text-zinc-600">
          盤後限定:即時報價沒有成交量,量能條件盤中無法判斷 → 收盤後選股、隔日進場。
        </p>
      </header>

      {passed.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface-1 p-6 text-center text-sm text-zinc-500">
          今天沒有六條全過的標的。
          <span className="text-zinc-600">(歷史上約 43% 的交易日會有,平均 2.2 檔)</span>
        </p>
      ) : (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-300">六條全過</h2>
          <ScanTable rows={passed} />
        </section>
      )}

      {near.length > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-sm font-medium text-zinc-300">差一條 ({near.length})</h2>
            <span className="text-xs text-zinc-600">
              門檻邊緣的標的 — 值得自己看一眼再決定要不要放行
            </span>
          </div>
          <ScanTable rows={near} />
          <ul className="space-y-0.5 px-1 text-[11px] text-zinc-600">
            {near.slice(0, 6).map((r) => (
              <li key={r.symbol}>
                <span className="font-mono text-zinc-500">{r.symbol}</span> {r.name} — 差:
                {missingLabels(r)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
