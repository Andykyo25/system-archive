import { TableShell, THead } from "@/app/_components/ui";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { unwrap } from "@/lib/db";
import { EVENT_LABEL, fmtMoney, fmtPct, pctColor } from "../_components/Format";

// 波段掃描(2026-07-17,Andy「排行對短線效益低」拍板)
// 候選 = 60 日強勢 + 趨勢未破(>MA60)+ 回檔至支撐(pullback)— Andy 贏單型態系統化。
// 定位:候選產生器非買訊;swing_scan_snapshot 每日累積,前向驗證有統計前標「驗證中」。
// 不動排名/因子(呈現層);熱股 = universe_dynamic 雷達(全市場三榜)晉升。

export const dynamic = "force-dynamic";

interface SwingRow {
  symbol: string;
  name: string | null;
  is_hot: boolean;
  latest_close: number | string | null;
  expected_rank: number | null;
  mom_score_pct: number | string | null;
  ret_60d_pct: number | string | null;
  ret_20d_pct: number | string | null;
  dev_ma20_pct: number | string | null;
  off_high_pct: number | string | null;
  vol_ratio_5_20: number | string | null;
  rsi14: number | string | null;
  atr_pct: number | string | null;
  patience_ma20: number | string | null;
}

function n(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function regimeZone(ret: number): { label: string; cls: string } {
  if (ret < 0) return { label: "歷史有利區(跌勢)", cls: "text-green-400" };
  if (ret < 10) return { label: "中性區", cls: "text-zinc-300" };
  if (ret < 20) return { label: "⚠ 策略地雷區", cls: "text-orange-400" };
  return { label: "歷史有利區(強漲)", cls: "text-green-400" };
}

export default async function SwingPage() {
  const sb = createClient();
  const [scanR, { data: regimeBars }] = await Promise.all([
    sb.from("v_swing_scan").select("*"),
    sb
      .from("price_daily")
      .select("close, adj_factor")
      .eq("symbol", "0050")
      .gt("close", 0)
      .order("trade_date", { ascending: false })
      .limit(61),
  ]);
  const rows = (unwrap(scanR, "v_swing_scan") as SwingRow[] | null) ?? [];

  // regime(同 dashboard 口徑)
  let regimeRet: number | null = null;
  {
    const bars =
      (regimeBars as { close: number | string; adj_factor: number | string | null }[] | null) ?? [];
    if (bars.length === 61) {
      const adj = (r: (typeof bars)[number]) => Number(r.close) * Number(r.adj_factor ?? 1);
      const base = adj(bars[60]);
      if (base > 0) regimeRet = (adj(bars[0]) / base - 1) * 100;
    }
  }
  const rz = regimeRet != null ? regimeZone(regimeRet) : null;

  // 7 日內事件
  const eventsMap: Record<string, { type: string; date: string }[]> = {};
  if (rows.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const { data: events } = await sb
      .from("stock_events")
      .select("symbol, event_type, event_date")
      .in("symbol", rows.map((r) => r.symbol))
      .gte("event_date", today)
      .lte("event_date", horizon)
      .order("event_date", { ascending: true });
    for (const e of (events as
      | { symbol: string; event_type: string; event_date: string }[]
      | null) ?? []) {
      (eventsMap[e.symbol] ??= []).push({ type: e.event_type, date: e.event_date });
    }
  }

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-line bg-surface-1 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-semibold">波段掃描 ({rows.length})</h1>
          {rz && regimeRet != null && (
            <span className="text-sm">
              <span className="text-zinc-500">Regime</span>{" "}
              <span className="tabular-nums">
                0050 近季 {regimeRet >= 0 ? "+" : ""}
                {regimeRet.toFixed(1)}%
              </span>{" "}
              <span className={`font-medium ${rz.cls}`}>{rz.label}</span>
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          條件:60 日漲幅 &gt;20% · 站上 MA60 · 回檔至支撐區(你的贏單型態)。
          候選產生器<b>非買訊</b> — 每日 snapshot 前向驗證中(起算 2026-07-17),買前必看下單頁警示與 sizing。
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface-1 p-8 text-center text-sm text-zinc-500">
          目前沒有符合條件的候選(強勢股都不在回檔區)
        </p>
      ) : (
        <TableShell>
          <table className="w-full text-sm">
            <THead>
              <tr>
                <th className="px-3 py-2">股號</th>
                <th className="px-3 py-2">名稱</th>
                <th className="px-3 py-2 text-right">現價</th>
                <th className="px-3 py-2 text-right" title="60 交易日漲幅(波段動能)">60日</th>
                <th className="px-3 py-2 text-right">20日</th>
                <th className="px-3 py-2 text-right" title="現價 vs MA20 偏離;負值越深越接近支撐,< -5% 有接刀風險(黃字)">
                  距MA20
                </th>
                <th className="px-3 py-2 text-right" title="距 60 日高點">離高</th>
                <th className="px-3 py-2 text-right" title="5日均量 / 20日均量(縮量回檔 <1 較健康)">量比</th>
                <th className="px-3 py-2 text-right">RSI</th>
                <th className="px-3 py-2 text-right" title="ATR14 / 現價(波段空間;也代表 1 張的風險量級)">ATR%</th>
                <th className="px-3 py-2 text-right" title="19 因子綜合排名(質篩參考)">綜合#</th>
                <th className="px-3 py-2">事件</th>
              </tr>
            </THead>
            <tbody>
              {rows.map((r) => {
                const dev = n(r.dev_ma20_pct);
                const deepPullback = dev != null && dev < -5;
                const evs = eventsMap[r.symbol] ?? [];
                return (
                  <tr key={r.symbol} className="border-t border-line-soft">
                    <td className="px-3 py-2 font-mono">
                      <Link
                        href={`/stocks/${r.symbol}`}
                        className="text-blue-400 hover:text-blue-300 hover:underline"
                      >
                        {r.symbol}
                      </Link>
                      {r.is_hot && (
                        <span
                          className="ml-1.5 rounded-full bg-orange-900/40 px-1.5 py-0.5 text-[10px] text-orange-300"
                          title="全市場雷達熱股(成交值/漲幅/新高帶量榜晉升)"
                        >
                          🔥
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-zinc-300">{r.name ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(r.latest_close, r.latest_close != null && Number(r.latest_close) < 100 ? 2 : 0)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.ret_60d_pct)}`}>
                      {fmtPct(r.ret_60d_pct)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.ret_20d_pct)}`}>
                      {fmtPct(r.ret_20d_pct)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        deepPullback ? "text-amber-400" : "text-zinc-300"
                      }`}
                      title={deepPullback ? "回檔已深(< -5%),接刀風險" : undefined}
                    >
                      {fmtPct(r.dev_ma20_pct)}
                      {deepPullback && " ⚠"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                      -{n(r.off_high_pct)?.toFixed(1) ?? "—"}%
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                      {n(r.vol_ratio_5_20)?.toFixed(2) ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                      {n(r.rsi14)?.toFixed(0) ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                      {n(r.atr_pct)?.toFixed(1) ?? "—"}%
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                      #{r.expected_rank ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {evs.length === 0 ? (
                        <span className="text-zinc-600">—</span>
                      ) : (
                        <span
                          className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[11px] text-amber-300"
                          title={evs.map((e) => `${EVENT_LABEL[e.type] ?? e.type} ${e.date}`).join("\n")}
                        >
                          📅 {EVENT_LABEL[evs[0].type] ?? evs[0].type} {evs[0].date.slice(5)}
                          {evs.length > 1 ? ` +${evs.length - 1}` : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableShell>
      )}
    </div>
  );
}
