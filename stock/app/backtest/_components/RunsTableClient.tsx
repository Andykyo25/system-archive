"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fmtPct } from "@/app/_components/Format";
import { deleteBacktestRun } from "../actions";

interface BacktestParams {
  start_date: string;
  end_date: string;
  rebalance_days: number;
  top_n: number;
  weight_strategy: string;
  benchmark_symbol: string;
}

interface BacktestSummary {
  win_rate?: number;
  total_return_pct?: number;
  annual_return_pct?: number;
  max_drawdown_pct?: number;
  sharpe?: number | null;
  alpha_vs_benchmark?: number;
  benchmark_return_pct?: number;
  n_trades?: number;
  n_rebalances?: number;
  reason?: string;
  message?: string;
}

interface BacktestRun {
  id: string;
  name: string;
  params: BacktestParams;
  summary: BacktestSummary | null;
  status: "running" | "finished" | "failed";
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const btnDangerCls =
  "rounded-md bg-red-900/50 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-900";

function fmtDate(s: string): string {
  return s.slice(0, 10) + " " + s.slice(11, 16);
}

function metricColor(v: number | undefined | null): string {
  if (v == null) return "text-zinc-400";
  if (!Number.isFinite(v) || v === 0) return "text-zinc-400";
  return v > 0 ? "text-red-400" : "text-green-400";
}

export function RunsTableClient({ runs }: { runs: BacktestRun[] }) {
  const router = useRouter();
  // 用 Set 管 selected IDs(只有 finished 的可選)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const finishedRuns = runs.filter((r) => r.status === "finished");

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onCompare() {
    if (selected.size < 2) return;
    const q = Array.from(selected)
      .map((id) => `ids=${encodeURIComponent(id)}`)
      .join("&");
    router.push(`/backtest/compare?${q}`);
  }

  function selectAll() {
    setSelected(new Set(finishedRuns.map((r) => r.id)));
  }
  function clearAll() {
    setSelected(new Set());
  }

  const canCompare = selected.size >= 2;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
        <div className="flex items-center gap-3">
          <span>
            已選{" "}
            <span className="font-semibold tabular-nums text-emerald-300">
              {selected.size}
            </span>{" "}
            個 · 勾 2 個以上可對比 equity curve
          </span>
          <button
            type="button"
            onClick={selectAll}
            className="text-blue-400 hover:underline"
            disabled={finishedRuns.length === 0}
          >
            全選 finished
          </button>
          <button
            type="button"
            onClick={clearAll}
            className="text-zinc-500 hover:text-zinc-300"
            disabled={selected.size === 0}
          >
            清空
          </button>
        </div>
        <button
          type="button"
          onClick={onCompare}
          disabled={!canCompare}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          對比選定 ({selected.size}) →
        </button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
            <tr>
              <th className="w-10 px-3 py-2 text-center">☐</th>
              <th className="px-3 py-2">名稱</th>
              <th className="px-3 py-2">狀態</th>
              <th className="px-3 py-2">日期區間</th>
              <th className="px-3 py-2 text-right">Top/N</th>
              <th className="px-3 py-2 text-right">勝率</th>
              <th className="px-3 py-2 text-right">總報酬</th>
              <th className="px-3 py-2 text-right">vs 0050 alpha</th>
              <th className="px-3 py-2 text-right">最大回撤</th>
              <th className="px-3 py-2">建立時間</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <RunRow
                key={r.id}
                run={r}
                checked={selected.has(r.id)}
                onToggle={() => toggle(r.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RunRow({
  run,
  checked,
  onToggle,
}: {
  run: BacktestRun;
  checked: boolean;
  onToggle: () => void;
}) {
  const p = run.params;
  const s = run.summary;
  const canSelect = run.status === "finished";
  const statusBadge =
    run.status === "finished" ? (
      <span className="rounded bg-green-800/50 px-2 py-0.5 text-xs text-green-200">
        finished
      </span>
    ) : run.status === "failed" ? (
      <span
        className="rounded bg-red-900/40 px-2 py-0.5 text-xs text-red-200"
        title={run.error ?? s?.reason ?? s?.message ?? ""}
      >
        failed{s?.reason ? ` · ${s.reason}` : ""}
      </span>
    ) : (
      <span className="rounded bg-yellow-900/40 px-2 py-0.5 text-xs text-yellow-200">
        running
      </span>
    );
  return (
    <tr
      className={`border-t border-zinc-800 ${checked ? "bg-emerald-950/20" : ""}`}
    >
      <td className="px-3 py-2 text-center">
        {canSelect ? (
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            className="h-4 w-4 cursor-pointer accent-emerald-600"
          />
        ) : (
          <span className="text-zinc-700">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        <Link
          href={`/backtest/${run.id}`}
          className="text-blue-400 hover:text-blue-300 hover:underline"
        >
          {run.name}
        </Link>
      </td>
      <td className="px-3 py-2">{statusBadge}</td>
      <td className="px-3 py-2 text-xs text-zinc-300">
        {p.start_date} → {p.end_date}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
        {p.top_n}/{p.rebalance_days}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {s?.win_rate != null ? `${s.win_rate.toFixed(1)}%` : "—"}
      </td>
      <td
        className={`px-3 py-2 text-right tabular-nums ${metricColor(s?.total_return_pct)}`}
      >
        {s?.total_return_pct != null ? fmtPct(s.total_return_pct) : "—"}
      </td>
      <td
        className={`px-3 py-2 text-right tabular-nums ${metricColor(s?.alpha_vs_benchmark)}`}
      >
        {s?.alpha_vs_benchmark != null ? fmtPct(s.alpha_vs_benchmark) : "—"}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
        {s?.max_drawdown_pct != null ? `-${s.max_drawdown_pct.toFixed(1)}%` : "—"}
      </td>
      <td className="px-3 py-2 text-xs text-zinc-500">{fmtDate(run.created_at)}</td>
      <td className="px-3 py-2 text-right">
        <form action={deleteBacktestRun} className="inline">
          <input type="hidden" name="id" value={run.id} />
          <button type="submit" className={btnDangerCls}>
            刪
          </button>
        </form>
      </td>
    </tr>
  );
}
