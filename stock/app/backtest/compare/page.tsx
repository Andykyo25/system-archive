import { TableShell, THead } from "@/app/_components/ui";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fmtPct } from "@/app/_components/Format";
import { canOverlay, type CurveSummary } from "@/lib/backtest-view";

export const dynamic = "force-dynamic";

interface BacktestParams {
  start_date: string;
  end_date: string;
  rebalance_days: number;
  top_n: number;
  weight_strategy: string;
  benchmark_symbol: string;
}

interface BacktestSummary extends CurveSummary {
  win_rate?: number;
  total_return_pct?: number;
  annual_return_pct?: number;
  max_drawdown_pct?: number;
  sharpe?: number | null;
  alpha_vs_benchmark?: number;
  benchmark_return_pct?: number;
  n_trades?: number;
  n_rebalances?: number;
  equity_curve?: number[];
  benchmark_equity_curve?: number[];
  rebalance_dates?: string[];
}

interface BacktestRun {
  id: string;
  name: string;
  params: BacktestParams;
  summary: BacktestSummary | null;
  status: "running" | "finished" | "failed";
  created_at: string;
}

// 為每個 run 派配固定顏色(stroke + text class,字面字串給 Tailwind JIT 掃 — 見 L24)
const PALETTE: { stroke: string; text: string }[] = [
  { stroke: "#facc15", text: "text-yellow-400" }, // yellow-400
  { stroke: "#34d399", text: "text-emerald-400" }, // emerald-400
  { stroke: "#60a5fa", text: "text-blue-400" }, // blue-400
  { stroke: "#a78bfa", text: "text-violet-400" }, // violet-400
  { stroke: "#f472b6", text: "text-pink-400" }, // pink-400
  { stroke: "#fb923c", text: "text-orange-400" }, // orange-400
  { stroke: "#22d3ee", text: "text-cyan-400" }, // cyan-400
  { stroke: "#f87171", text: "text-red-400" }, // red-400
];

export default async function BacktestComparePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const rawIds = sp.ids;
  const ids = (
    Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []
  ).filter((s): s is string => typeof s === "string" && s.length > 0);

  if (ids.length === 0) {
    return <EmptyState reason="no_ids" />;
  }

  const sb = createClient();
  const { data: runs } = await sb
    .from("backtest_runs")
    .select("*")
    .in("id", ids)
    .order("created_at", { ascending: true });

  const runList = (runs as BacktestRun[] | null) ?? [];
  const finished = runList.filter(
    (r) => r.status === "finished" && r.summary?.equity_curve,
  );

  if (finished.length === 0) {
    return <EmptyState reason="no_finished_runs" />;
  }

  // 配色:依照當下 list 順序賦予 palette index(穩定)
  const colored = finished.map((r, i) => ({
    ...r,
    color: PALETTE[i % PALETTE.length],
  }));

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-line bg-surface-1 p-4">
        <Link href="/backtest" className="text-xs text-zinc-400 hover:text-zinc-200">
          ← 回 Backtest 列表
        </Link>
        <h1 className="mt-1 text-xl font-semibold">
          回測對比 ({finished.length} runs)
        </h1>
        <p className="mt-2 text-xs text-zinc-500">
          資產曲線以本金 1.00 正規化。成交版本、帳務版本、估值日期與基準一致時才疊圖。
        </p>
      </header>

      <SummaryTable runs={colored} />
      {canOverlay(finished) ? <EquityOverlay runs={colored} /> : <p className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-200">所選回測的版本、日期或基準不一致，暫不疊圖。下表數字僅供各次結果查閱，請選擇相同口徑後比較。</p>}
    </div>
  );
}

function EmptyState({
  reason,
}: {
  reason: "no_ids" | "no_finished_runs";
}) {
  return (
    <div className="space-y-4">
      <Link href="/backtest" className="text-xs text-zinc-400 hover:text-zinc-200">
        ← 回 Backtest 列表
      </Link>
      <div className="rounded-2xl border border-line bg-surface-1 p-8 text-center">
        <p className="text-zinc-400">
          {reason === "no_ids"
            ? "未指定要對比的 run"
            : "選定的 run 都還沒 finished 或無 equity_curve"}
        </p>
        <p className="mt-2 text-sm text-zinc-500">
          回 /backtest 勾選 2 個以上 finished run,再點「對比選定」
        </p>
      </div>
    </div>
  );
}

type ColoredRun = BacktestRun & { color: (typeof PALETTE)[number] };

function SummaryTable({ runs }: { runs: ColoredRun[] }) {
  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">Summary 對比</h2>
      <TableShell>
        <table className="w-full text-sm">
          <THead>
            <tr>
              <th className="px-3 py-2"></th>
              <th className="px-3 py-2">名稱</th>
              <th className="px-3 py-2">參數</th>
              <th className="px-3 py-2 text-right">總報酬</th>
              <th className="px-3 py-2 text-right">vs 0050 Alpha</th>
              <th className="px-3 py-2 text-right">Sharpe</th>
              <th className="px-3 py-2 text-right">最大回撤</th>
              <th className="px-3 py-2 text-right">勝率</th>
            </tr>
          </THead>
          <tbody>
            {runs.map((r) => {
              const s = r.summary ?? {};
              return (
                <tr key={r.id} className="border-t border-line-soft">
                  <td className="px-3 py-2">
                    <span
                      className="inline-block h-3 w-3 rounded-sm"
                      style={{ backgroundColor: r.color.stroke }}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/backtest/${r.id}`}
                      className={`hover:underline ${r.color.text}`}
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">
                    top {r.params.top_n} / N {r.params.rebalance_days} /{" "}
                    {r.params.start_date.slice(0, 7)}–
                    {r.params.end_date.slice(0, 7)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {s.total_return_pct != null
                      ? fmtPct(s.total_return_pct)
                      : "—"}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${
                      s.alpha_vs_benchmark == null
                        ? "text-zinc-400"
                        : s.alpha_vs_benchmark > 0
                          ? "text-red-400"
                          : "text-green-400"
                    }`}
                  >
                    {s.alpha_vs_benchmark != null
                      ? fmtPct(s.alpha_vs_benchmark)
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {s.sharpe != null ? s.sharpe.toFixed(2) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                    {s.max_drawdown_pct != null
                      ? `-${s.max_drawdown_pct.toFixed(1)}%`
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {s.win_rate != null ? `${s.win_rate.toFixed(1)}%` : "—"}
                  </td>
                </tr>
              );
            })}
            {/* Benchmark row(取第一個 run 的 benchmark) */}
            {runs[0]?.summary?.benchmark_return_pct != null && (
              <tr className="border-t border-line-soft bg-surface-raised">
                <td className="px-3 py-2">
                  <span className="inline-block h-3 w-3 rounded-sm bg-zinc-500" />
                </td>
                <td className="px-3 py-2 text-zinc-300">
                  Benchmark{" "}
                  <span className="font-mono text-xs text-zinc-500">
                    {runs[0].params.benchmark_symbol}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-zinc-500">同期持有</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                  {fmtPct(runs[0].summary!.benchmark_return_pct!)}
                </td>
                <td className="px-3 py-2 text-right text-zinc-500">—</td>
                <td className="px-3 py-2 text-right text-zinc-500">—</td>
                <td className="px-3 py-2 text-right text-zinc-500">—</td>
                <td className="px-3 py-2 text-right text-zinc-500">—</td>
              </tr>
            )}
          </tbody>
        </table>
      </TableShell>
    </section>
  );
}

function EquityOverlay({ runs }: { runs: ColoredRun[] }) {
  // canOverlay verifies that every index represents the same date/model.
  const allCurves = runs
    .map((r) => r.summary?.equity_curve ?? [])
    .filter((c) => c.length >= 2);
  if (allCurves.length === 0) return null;

  const firstRun = runs[0];
  const benchmark = firstRun.summary?.benchmark_equity_curve ?? [];
  const labelDates = firstRun.summary?.equity_dates ?? firstRun.summary?.rebalance_dates ?? [];

  const maxLen = Math.max(
    benchmark.length,
    ...allCurves.map((c) => c.length),
  );
  const allValues: number[] = [
    ...allCurves.flat(),
    ...benchmark,
  ];
  const minV = Math.min(...allValues, 0.9);
  const maxV = Math.max(...allValues, 1.1);

  const W = 900;
  const H = 320;
  const padL = 50;
  const padR = 20;
  const padT = 20;
  const padB = 40;
  const xStep = maxLen > 1 ? (W - padL - padR) / (maxLen - 1) : 0;
  const yScale = (v: number) =>
    padT + (H - padT - padB) * (1 - (v - minV) / (maxV - minV));

  // Preserve every point, including brief drawdowns between rebalance dates.
  function pathFor(curve: number[]): string {
    if (curve.length === 0) return "";
    const step = 1;
    const pts: string[] = [];
    for (let i = 0; i < curve.length; i += step) {
      pts.push(`${pts.length === 0 ? "M" : "L"} ${padL + i * xStep} ${yScale(curve[i])}`);
    }
    const last = curve.length - 1;
    if (last % step !== 0) pts.push(`L ${padL + last * xStep} ${yScale(curve[last])}`);
    return pts.join(" ");
  }

  // X 軸 tick:取首中尾 + 若 maxLen > 6,中間多幾個
  const tickCount = Math.min(7, maxLen);
  const tickIdxs = Array.from(
    new Set(
      Array.from({ length: tickCount }, (_, i) =>
        Math.round((maxLen - 1) * (i / (tickCount - 1))),
      ),
    ),
  );

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">資產曲線疊圖</h2>
      <div className="rounded-2xl border border-line bg-surface-1 p-4">
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="text-xs">
          {/* y baseline = 1.0(本金) */}
          <line
            x1={padL}
            x2={W - padR}
            y1={yScale(1)}
            y2={yScale(1)}
            stroke="#52525b"
            strokeDasharray="3 3"
          />
          {/* Benchmark(灰實線) */}
          {benchmark.length >= 2 && (
            <path
              d={pathFor(benchmark)}
              fill="none"
              stroke="#a1a1aa"
              strokeWidth="1.5"
            />
          )}
          {/* Strategy curves */}
          {runs.map((r) => {
            const c = r.summary?.equity_curve ?? [];
            if (c.length < 2) return null;
            return (
              <path
                key={r.id}
                d={pathFor(c)}
                fill="none"
                stroke={r.color.stroke}
                strokeWidth="2"
              />
            );
          })}
          {/* X axis labels */}
          {tickIdxs.map((i) => (
            <text
              key={i}
              x={padL + i * xStep}
              y={H - padB + 16}
              textAnchor={i === 0 ? "start" : i === maxLen - 1 ? "end" : "middle"}
              className="fill-zinc-500"
              fontSize="10"
            >
              {labelDates[i]?.slice(2, 10) ?? `t${i}`}
            </text>
          ))}
          {/* Y axis labels */}
          <text
            x={padL - 6}
            y={yScale(minV) + 4}
            textAnchor="end"
            className="fill-zinc-500"
            fontSize="10"
          >
            {minV.toFixed(2)}
          </text>
          <text
            x={padL - 6}
            y={yScale(maxV) + 4}
            textAnchor="end"
            className="fill-zinc-500"
            fontSize="10"
          >
            {maxV.toFixed(2)}
          </text>
          <text
            x={padL - 6}
            y={yScale(1) + 4}
            textAnchor="end"
            className="fill-zinc-400"
            fontSize="10"
          >
            1.00
          </text>
        </svg>
        {/* Legend */}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {runs.map((r) => (
            <span key={r.id} className={r.color.text}>
              ━ {r.name}
            </span>
          ))}
          {benchmark.length >= 2 && (
            <span className="text-zinc-400">
              ━ {firstRun.params.benchmark_symbol} (benchmark)
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
