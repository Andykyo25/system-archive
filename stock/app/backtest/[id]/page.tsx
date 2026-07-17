import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fmtMoney, fmtPct, pctColor } from "@/app/_components/Format";

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
  equity_curve?: number[];
  benchmark_equity_curve?: number[];
  rebalance_dates?: string[];
  reason?: string;
  message?: string;
  trade_days_found?: number;
  trade_days_required?: number;
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

interface BacktestTrade {
  id: number;
  run_id: string;
  symbol: string;
  entry_date: string;
  exit_date: string;
  entry_price: number | string;
  exit_price: number | string;
  qty: number | string;
  return_pct: number | string | null;
  entry_rank: number | null;
  is_benchmark: boolean;
}

export default async function BacktestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sb = createClient();

  const [{ data: run }, { data: trades }] = await Promise.all([
    sb.from("backtest_runs").select("*").eq("id", id).maybeSingle(),
    sb
      .from("backtest_trades")
      .select("*")
      .eq("run_id", id)
      .order("entry_date", { ascending: true })
      .limit(2000),
  ]);

  if (!run) return notFound();
  const r = run as BacktestRun;
  const tradeRows = (trades as BacktestTrade[] | null) ?? [];

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-4">
        <div className="flex items-baseline justify-between">
          <div>
            <Link
              href="/backtest"
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              ← 回 Backtest 列表
            </Link>
            <h1 className="mt-1 text-xl font-semibold">{r.name}</h1>
          </div>
          <StatusBadge run={r} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-zinc-400 md:grid-cols-6">
          <Pill label="起始" value={r.params.start_date} />
          <Pill label="結束" value={r.params.end_date} />
          <Pill label="N 天換股" value={String(r.params.rebalance_days)} />
          <Pill label="Top K" value={String(r.params.top_n)} />
          <Pill label="權重" value={r.params.weight_strategy} />
          <Pill label="Benchmark" value={r.params.benchmark_symbol} />
        </div>
      </header>

      {r.status === "failed" ? (
        <FailedReason run={r} />
      ) : r.status === "running" ? (
        <RunningCard />
      ) : (
        <FinishedView run={r} trades={tradeRows} />
      )}
    </div>
  );
}

function StatusBadge({ run }: { run: BacktestRun }) {
  if (run.status === "finished") {
    return (
      <span className="rounded bg-green-800/50 px-3 py-1 text-sm text-green-200">
        finished
      </span>
    );
  }
  if (run.status === "failed") {
    return (
      <span className="rounded bg-red-900/40 px-3 py-1 text-sm text-red-200">
        failed
      </span>
    );
  }
  return (
    <span className="rounded bg-yellow-900/40 px-3 py-1 text-sm text-yellow-200">
      running
    </span>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-zinc-800 px-2 py-1">
      <span className="text-zinc-500">{label}:</span>{" "}
      <span className="font-mono text-zinc-200">{value}</span>
    </div>
  );
}

function FailedReason({ run }: { run: BacktestRun }) {
  const s = run.summary ?? {};
  return (
    <div className="rounded-lg border border-red-900/40 bg-red-950/30 p-4">
      <div className="text-sm font-semibold text-red-200">回測失敗</div>
      <div className="mt-2 text-sm text-red-100">
        reason: <code className="font-mono">{s.reason ?? run.error ?? "unknown"}</code>
      </div>
      {s.message ? (
        <div className="mt-1 text-xs text-red-200/80">{s.message}</div>
      ) : null}
      {s.trade_days_found != null ? (
        <div className="mt-2 text-xs text-red-200/80">
          找到 {s.trade_days_found} 個交易日,需要 ≥ {s.trade_days_required}
        </div>
      ) : null}
      <div className="mt-3 text-xs text-zinc-400">
        提示:price_daily 還沒累積足夠歷史(目前 M8 cron 從 2026-05-07 起跑)。等 Andy
        手動 trigger `fetch-finmind-backfill` 把 3 年資料補齊,backtest 才能跑出有意義結果。
      </div>
    </div>
  );
}

function RunningCard() {
  return (
    <div className="rounded-lg border border-yellow-900/40 bg-yellow-950/20 p-4 text-sm text-yellow-200">
      回測執行中… 重新整理頁面查看進度。
    </div>
  );
}

function FinishedView({
  run,
  trades,
}: {
  run: BacktestRun;
  trades: BacktestTrade[];
}) {
  const s = run.summary ?? {};
  return (
    <>
      <SummaryCards summary={s} />
      <EquityCurveChart summary={s} />
      <MonthlyPnLChart trades={trades} />
      <TradesTable trades={trades} />
    </>
  );
}

function SummaryCards({ summary }: { summary: BacktestSummary }) {
  const cards: {
    label: string;
    value: string;
    color?: string;
    sub?: string;
  }[] = [
    {
      label: "勝率",
      value: summary.win_rate != null ? `${summary.win_rate.toFixed(1)}%` : "—",
      sub: `${summary.n_trades ?? 0} trades × ${summary.n_rebalances ?? 0} 期`,
    },
    {
      label: "總報酬",
      value:
        summary.total_return_pct != null
          ? fmtPct(summary.total_return_pct)
          : "—",
      color: pctColor(summary.total_return_pct),
      sub: `年化 ${summary.annual_return_pct != null ? fmtPct(summary.annual_return_pct) : "—"}`,
    },
    {
      label: "vs 0050 Alpha",
      value:
        summary.alpha_vs_benchmark != null
          ? fmtPct(summary.alpha_vs_benchmark)
          : "—",
      color: pctColor(summary.alpha_vs_benchmark),
      sub: `0050 同期 ${summary.benchmark_return_pct != null ? fmtPct(summary.benchmark_return_pct) : "—"}`,
    },
    {
      label: "最大回撤",
      value:
        summary.max_drawdown_pct != null
          ? `-${summary.max_drawdown_pct.toFixed(1)}%`
          : "—",
      color: "text-zinc-200",
      sub:
        summary.sharpe != null
          ? `Sharpe ${summary.sharpe.toFixed(2)}`
          : "Sharpe —",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-4">
          <div className="text-xs text-zinc-400">{c.label}</div>
          <div
            className={`mt-1 text-2xl font-semibold tabular-nums ${c.color ?? ""}`}
          >
            {c.value}
          </div>
          {c.sub ? <div className="text-xs text-zinc-500">{c.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

function EquityCurveChart({ summary }: { summary: BacktestSummary }) {
  const ec = summary.equity_curve ?? [];
  const bc = summary.benchmark_equity_curve ?? [];
  const dates = summary.rebalance_dates ?? [];
  if (ec.length < 2) return null;

  const W = 800;
  const H = 220;
  const padL = 40;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  const allVals = [...ec, ...bc];
  const minV = Math.min(...allVals, 0.9);
  const maxV = Math.max(...allVals, 1.1);
  const xStep = (W - padL - padR) / (ec.length - 1);
  const yScale = (v: number) =>
    padT + (H - padT - padB) * (1 - (v - minV) / (maxV - minV));

  // path 點數 stride 取樣到 ~240(viewBox 800px 已超像素密度),x 用原索引保對齊、
  // 保尾點 — 長 curve(數百期)HTML path 字串瘦身,視覺無差
  const pathFor = (curve: number[]) => {
    if (curve.length === 0) return "";
    const step = Math.max(1, Math.ceil(curve.length / 240));
    const pts: string[] = [];
    for (let i = 0; i < curve.length; i += step) {
      pts.push(`${pts.length === 0 ? "M" : "L"} ${padL + i * xStep} ${yScale(curve[i])}`);
    }
    const last = curve.length - 1;
    if (last % step !== 0) pts.push(`L ${padL + last * xStep} ${yScale(curve[last])}`);
    return pts.join(" ");
  };

  // x-axis tick labels(取首中尾)
  const labelIdxs = [
    0,
    Math.floor((ec.length - 1) / 2),
    ec.length - 1,
  ];
  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">資產曲線 vs Benchmark</h2>
      <div className="rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-4">
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="text-xs">
          {/* y baseline = 1.0 */}
          <line
            x1={padL}
            x2={W - padR}
            y1={yScale(1)}
            y2={yScale(1)}
            stroke="#52525b"
            strokeDasharray="3 3"
          />
          {/* benchmark line */}
          <path
            d={pathFor(bc)}
            fill="none"
            stroke="#a1a1aa"
            strokeWidth="1.5"
          />
          {/* strategy line */}
          <path
            d={pathFor(ec)}
            fill="none"
            stroke="#facc15"
            strokeWidth="2"
          />
          {/* axis labels */}
          {labelIdxs.map((i) => (
            <text
              key={i}
              x={padL + i * xStep}
              y={H - padB + 14}
              textAnchor="middle"
              className="fill-zinc-500"
              fontSize="10"
            >
              {dates[i]?.slice(2, 10) ?? `t${i}`}
            </text>
          ))}
          {/* y labels */}
          <text
            x={padL - 4}
            y={yScale(minV) + 4}
            textAnchor="end"
            className="fill-zinc-500"
            fontSize="10"
          >
            {minV.toFixed(2)}
          </text>
          <text
            x={padL - 4}
            y={yScale(maxV) + 4}
            textAnchor="end"
            className="fill-zinc-500"
            fontSize="10"
          >
            {maxV.toFixed(2)}
          </text>
          <text
            x={padL - 4}
            y={yScale(1) + 4}
            textAnchor="end"
            className="fill-zinc-400"
            fontSize="10"
          >
            1.00
          </text>
        </svg>
        <div className="mt-2 flex gap-4 text-xs">
          <span className="text-yellow-400">━ 策略</span>
          <span className="text-zinc-400">━ Benchmark</span>
        </div>
      </div>
    </section>
  );
}

function MonthlyPnLChart({ trades }: { trades: BacktestTrade[] }) {
  // 把策略 trades(非 benchmark)按月聚合報酬:每月平均報酬 %
  // exit_date 落哪個月就算哪個月
  const monthMap = new Map<string, { sum: number; n: number }>();
  for (const t of trades) {
    if (t.is_benchmark) continue;
    const m = t.exit_date.slice(0, 7);
    const r = Number(t.return_pct);
    if (!Number.isFinite(r)) continue;
    const slot = monthMap.get(m) ?? { sum: 0, n: 0 };
    slot.sum += r;
    slot.n += 1;
    monthMap.set(m, slot);
  }
  const months = Array.from(monthMap.keys()).sort();
  if (months.length === 0) return null;
  const monthData = months.map((m) => {
    const slot = monthMap.get(m)!;
    return { month: m, avg: slot.sum / slot.n };
  });
  const maxAbs = Math.max(
    ...monthData.map((d) => Math.abs(d.avg)),
    1,
  );

  const W = 800;
  const H = 200;
  const padL = 40;
  const padR = 10;
  const padT = 10;
  const padB = 40;
  const barWidth = Math.max(8, (W - padL - padR) / monthData.length - 4);
  const midY = padT + (H - padT - padB) / 2;
  const yScale = (v: number) =>
    midY - (v / maxAbs) * ((H - padT - padB) / 2);

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">月度平均報酬</h2>
      <div className="rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-4">
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="text-xs">
          <line
            x1={padL}
            x2={W - padR}
            y1={midY}
            y2={midY}
            stroke="#52525b"
          />
          {monthData.map((d, i) => {
            const x =
              padL + i * ((W - padL - padR) / monthData.length) + 2;
            const y = d.avg >= 0 ? yScale(d.avg) : midY;
            const h = Math.abs(midY - yScale(d.avg));
            // 台股配色:紅 = 漲,綠 = 跌
            const cls = d.avg >= 0 ? "fill-red-500" : "fill-green-500";
            return (
              <g key={d.month}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={h}
                  className={cls}
                />
                <title>
                  {d.month}: {d.avg >= 0 ? "+" : ""}
                  {d.avg.toFixed(2)}%
                </title>
              </g>
            );
          })}
          {/* x labels:每隔幾個顯示 */}
          {monthData.map((d, i) => {
            const step = Math.max(1, Math.floor(monthData.length / 8));
            if (i % step !== 0 && i !== monthData.length - 1) return null;
            const x =
              padL +
              i * ((W - padL - padR) / monthData.length) +
              barWidth / 2 +
              2;
            return (
              <text
                key={d.month}
                x={x}
                y={H - padB + 14}
                textAnchor="middle"
                className="fill-zinc-500"
                fontSize="10"
              >
                {d.month.slice(2)}
              </text>
            );
          })}
          <text
            x={padL - 4}
            y={yScale(maxAbs) + 4}
            textAnchor="end"
            className="fill-zinc-500"
            fontSize="10"
          >
            +{maxAbs.toFixed(1)}%
          </text>
          <text
            x={padL - 4}
            y={yScale(-maxAbs) + 4}
            textAnchor="end"
            className="fill-zinc-500"
            fontSize="10"
          >
            -{maxAbs.toFixed(1)}%
          </text>
          <text
            x={padL - 4}
            y={midY + 4}
            textAnchor="end"
            className="fill-zinc-400"
            fontSize="10"
          >
            0%
          </text>
        </svg>
      </div>
    </section>
  );
}

function TradesTable({ trades }: { trades: BacktestTrade[] }) {
  const top = trades.slice(0, 200);
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">交易明細</h2>
        <span className="text-xs text-zinc-500">
          {trades.length} 筆,顯示前 200 · benchmark 用灰底
        </span>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-white/[0.06] bg-zinc-900/60">
        <table className="w-full text-sm">
          <thead className="border-b border-white/[0.06] text-left text-[11px] uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-3 py-2">股號</th>
              <th className="px-3 py-2 text-right">Rank</th>
              <th className="px-3 py-2">進場日</th>
              <th className="px-3 py-2 text-right">進場價</th>
              <th className="px-3 py-2">出場日</th>
              <th className="px-3 py-2 text-right">出場價</th>
              <th className="px-3 py-2 text-right">報酬</th>
            </tr>
          </thead>
          <tbody>
            {top.map((t) => (
              <tr
                key={t.id}
                className={`border-t border-white/[0.04] ${t.is_benchmark ? "bg-zinc-950/60" : ""}`}
              >
                <td className="px-3 py-2 font-mono">
                  <Link
                    href={`/stocks/${t.symbol}`}
                    className="text-blue-400 hover:text-blue-300 hover:underline"
                  >
                    {t.symbol}
                  </Link>
                  {t.is_benchmark && (
                    <span className="ml-1 rounded bg-zinc-700 px-1 text-[10px] text-zinc-300">
                      BM
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                  {t.entry_rank ?? "—"}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-300">{t.entry_date}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtMoney(t.entry_price, 2)}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-300">{t.exit_date}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtMoney(t.exit_price, 2)}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${pctColor(t.return_pct)}`}
                >
                  {fmtPct(t.return_pct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
