import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fmtPct } from "@/app/_components/Format";
import { createBacktestRun, deleteBacktestRun } from "./actions";

export const dynamic = "force-dynamic";

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

const inputCls =
  "rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none";
const btnCls =
  "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50";
const btnDangerCls =
  "rounded-md bg-red-900/50 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-900";

export default async function BacktestPage() {
  const sb = createClient();
  const { data: runs } = await sb
    .from("backtest_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  const runList = (runs as BacktestRun[] | null) ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = new Date(Date.now() - 365 * 86400 * 1000)
    .toISOString()
    .slice(0, 10);

  return (
    <div className="space-y-8">
      <header className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h1 className="text-xl font-semibold">Backtest 回測</h1>
        <p className="mt-2 text-xs text-zinc-500">
          Walk-forward 多因子回測:每 N 個交易日重新 rank,取 top-K 等權持有,vs 0050 同期。
          需要 price_daily 涵蓋足夠歷史(start_date 到 end_date 至少 rebalance_days × 2 個交易日)。
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-lg font-semibold">新增回測</h2>
        <form
          action={createBacktestRun}
          className="grid grid-cols-1 gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4 md:grid-cols-[1fr_140px_140px_100px_100px_100px_auto]"
        >
          <div>
            <label className="mb-1 block text-xs text-zinc-400">名稱</label>
            <input
              name="name"
              placeholder="例如:M10 smoke"
              required
              className={`${inputCls} w-full`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-400">起始日</label>
            <input
              name="start_date"
              type="date"
              defaultValue={defaultStart}
              required
              className={`${inputCls} w-full`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-400">
              結束日(預設今日)
            </label>
            <input
              name="end_date"
              type="date"
              defaultValue={today}
              className={`${inputCls} w-full`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-400" title="N 個交易日換股一次">
              N (天)
            </label>
            <input
              name="rebalance_days"
              type="number"
              min="5"
              max="250"
              defaultValue="20"
              className={`${inputCls} w-full text-right`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-400">Top K</label>
            <input
              name="top_n"
              type="number"
              min="1"
              max="100"
              defaultValue="10"
              className={`${inputCls} w-full text-right`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-400">Benchmark</label>
            <input
              name="benchmark_symbol"
              defaultValue="0050"
              className={`${inputCls} w-full font-mono`}
            />
          </div>
          <div className="flex items-end">
            <button className={btnCls} type="submit">
              執行
            </button>
          </div>
        </form>
        <p className="mt-2 text-xs text-zinc-500">
          ⚠ EF 同步執行,依資料量可能需 30s~2min。
          資料不足會 graceful 回 failed + reason=insufficient_data,不會 crash。
        </p>
      </section>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">歷史回測</h2>
          <span className="text-xs text-zinc-500">最近 50 筆</span>
        </div>
        {runList.length === 0 ? (
          <EmptyState />
        ) : (
          <RunTable runs={runList} />
        )}
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center">
      <p className="text-zinc-400">尚無回測紀錄</p>
      <p className="mt-2 text-sm text-zinc-500">
        填上面的表單跑一次。資料不足時會 graceful 失敗,可在 row 看 reason。
      </p>
    </div>
  );
}

function fmtDate(s: string): string {
  return s.slice(0, 10) + " " + s.slice(11, 16);
}

function metricColor(v: number | undefined | null): string {
  if (v == null) return "text-zinc-400";
  if (!Number.isFinite(v) || v === 0) return "text-zinc-400";
  return v > 0 ? "text-red-400" : "text-green-400";
}

function RunTable({ runs }: { runs: BacktestRun[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
      <table className="w-full text-sm">
        <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
          <tr>
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
            <RunRow key={r.id} run={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunRow({ run }: { run: BacktestRun }) {
  const p = run.params;
  const s = run.summary;
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
    <tr className="border-t border-zinc-800">
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
