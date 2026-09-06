import { TableShell, THead } from "@/app/_components/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fmtMoney, fmtPct, pctColor } from "@/app/_components/Format";
import { readAll, unwrap } from "@/lib/db";
import { monthlyEquityReturns, type CurveSummary } from "@/lib/backtest-view";

export const dynamic = "force-dynamic";

interface BacktestParams {
  start_date: string;
  end_date: string;
  rebalance_days: number;
  top_n: number;
  weight_strategy: string;
  benchmark_symbol: string;
  exec_model?: string;
}

interface BacktestSummary extends CurveSummary {
  n_open_positions?: number;
  stale_mark_days?: number;
  initial_capital?: number;
  cash_curve?: number[];
  market_value_curve?: number[];
  open_positions?: {
    symbol: string;
    qty: number;
    last_price: number;
    last_price_date: string;
    market_value: number;
    scheduled_exit_date: string;
  }[];
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

  const [runResult, tradeResult] = await Promise.all([
    sb.from("backtest_runs").select("*").eq("id", id).maybeSingle(),
    readAll<BacktestTrade>((from, to) =>
      sb
        .from("backtest_trades")
        .select("*")
        .eq("run_id", id)
        .order("entry_date", { ascending: true })
        .order("id")
        .range(from, to),
    ),
  ]);
  const run = unwrap(runResult, "回測結果");
  const trades = unwrap(tradeResult, "回測交易");
  if (!run) return notFound();
  const r = run as BacktestRun;
  const tradeRows = (trades as BacktestTrade[] | null) ?? [];

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-line bg-surface-1 p-4">
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

      <p className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm leading-6 text-amber-200">
        此頁驗證多因子排名，與起漲掃描是不同策略。
        {r.summary?.accounting_version === "daily-cash-ledger-v1"
          ? "本次使用逐日現金與持股估值計算回撤；延後出場的資金待成交才回到現金。尚未納入滑價、最小手續費與整股限制。"
          : "舊版回撤僅按換股節點計算，可能低估持有期間風險。"}
        不同成交與帳務版本請分開比較。
        {r.params.exec_model === "close" &&
          " 本次使用訊號日收盤成交，含當日資訊，只作診斷用途。"}
      </p>

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
        reason:{" "}
        <code className="font-mono">{s.reason ?? run.error ?? "unknown"}</code>
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
        提示:price_daily 還沒累積足夠歷史(目前 M8 cron 從 2026-05-07 起跑)。等
        Andy 手動 trigger `fetch-finmind-backfill` 把 3 年資料補齊,backtest
        才能跑出有意義結果。
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
      <SummaryCards summary={s} benchmark={run.params.benchmark_symbol} />
      <AccountState summary={s} />
      <EquityCurveChart summary={s} />
      <MonthlyPnLChart trades={trades} summary={s} />
      <TradesTable trades={trades} />
    </>
  );
}

function SummaryCards({
  summary,
  benchmark,
}: {
  summary: BacktestSummary;
  benchmark: string;
}) {
  const cards: {
    label: string;
    value: string;
    color?: string;
    sub?: string;
  }[] = [
    {
      label: "勝率",
      value:
        summary.n_trades && summary.win_rate != null
          ? `${summary.win_rate.toFixed(1)}%`
          : "—",
      sub: `${summary.n_trades ?? 0} 筆已平倉 · ${summary.n_rebalances ?? 0} 期`,
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
      label: `vs ${benchmark} 超額`,
      value:
        summary.alpha_vs_benchmark != null
          ? fmtPct(summary.alpha_vs_benchmark)
          : "—",
      color: pctColor(summary.alpha_vs_benchmark),
      sub: `${benchmark} 同期 ${summary.benchmark_return_pct != null ? fmtPct(summary.benchmark_return_pct) : "—"}`,
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
        <div
          key={c.label}
          className="rounded-2xl border border-line bg-surface-1 p-4"
        >
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

function AccountState({ summary: s }: { summary: BacktestSummary }) {
  if (s.accounting_version !== "daily-cash-ledger-v1") return null;
  const capital = s.initial_capital ?? 1_000_000;
  return (
    <section className="rounded-2xl border border-line bg-surface-1 p-4 text-sm">
      <h2 className="font-semibold">期末帳戶狀態</h2>
      <p className="mt-2 text-slate-300">
        現金 {fmtMoney((s.cash_curve?.at(-1) ?? 0) * capital, 0)} 元 · 持股估值{" "}
        {fmtMoney((s.market_value_curve?.at(-1) ?? 0) * capital, 0)} 元 · 未平倉{" "}
        {s.n_open_positions ?? 0} 檔
      </p>
      <p className="mt-2 text-xs text-slate-400">
        回撤依逐日收盤淨值；未平倉估值尚未扣未來賣出成本。缺少當日收盤價時沿用最後已知價格，本次有{" "}
        {s.stale_mark_days ?? 0} 日受影響。
      </p>
      {!!s.open_positions?.length && (
        <ul className="mt-3 space-y-2 text-xs text-amber-200">
          {s.open_positions.map((p) => (
            <li key={p.symbol}>
              {p.symbol} · 原訂退出 {p.scheduled_exit_date} · 尚未成交 · 估值日{" "}
              {p.last_price_date}，市值 {fmtMoney(p.market_value, 0)} 元
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EquityCurveChart({ summary }: { summary: BacktestSummary }) {
  const ec = summary.equity_curve ?? [];
  const bc = summary.benchmark_equity_curve ?? [];
  const dates =
    summary.equity_dates ??
    (summary.rebalance_dates?.length === ec.length
      ? summary.rebalance_dates
      : []);
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

  // Preserve every daily point so short drawdowns do not disappear from the chart.
  const pathFor = (curve: number[]) => {
    if (curve.length === 0) return "";
    const step = 1;
    const pts: string[] = [];
    for (let i = 0; i < curve.length; i += step) {
      pts.push(
        `${pts.length === 0 ? "M" : "L"} ${padL + i * xStep} ${yScale(curve[i])}`,
      );
    }
    const last = curve.length - 1;
    if (last % step !== 0)
      pts.push(`L ${padL + last * xStep} ${yScale(curve[last])}`);
    return pts.join(" ");
  };

  // x-axis tick labels(取首中尾)
  const labelIdxs = [0, Math.floor((ec.length - 1) / 2), ec.length - 1];
  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">資產曲線 vs Benchmark</h2>
      <div className="rounded-2xl border border-line bg-surface-1 p-4">
        <svg role="img" aria-label="策略與基準資產曲線" width="100%" viewBox={`0 0 ${W} ${H}`} className="text-xs">
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
          <path d={pathFor(ec)} fill="none" stroke="#facc15" strokeWidth="2" />
          {/* axis labels */}
          {labelIdxs.map((i) => (
            <text
              key={i}
              x={padL + i * xStep}
              y={H - padB + 14}
              textAnchor={i === 0 ? "start" : i === ec.length - 1 ? "end" : "middle"}
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

function MonthlyPnLChart({
  trades,
  summary,
}: {
  trades: BacktestTrade[];
  summary: BacktestSummary;
}) {
  // 把策略 trades(非 benchmark)按月聚合報酬:每月平均報酬 %
  // exit_date 落哪個月就算哪個月
  const monthMap = new Map<string, { sum: number; n: number }>();
  for (const t of trades) {
    if (t.is_benchmark) continue;
    const m = t.exit_date.slice(0, 7);
    if (t.return_pct == null) continue;
    const r = Number(t.return_pct);
    if (!Number.isFinite(r)) continue;
    const slot = monthMap.get(m) ?? { sum: 0, n: 0 };
    slot.sum += r;
    slot.n += 1;
    monthMap.set(m, slot);
  }
  const months = Array.from(monthMap.keys()).sort();
  const dailyMonths = monthlyEquityReturns(summary);
  const monthData =
    dailyMonths ??
    months.map((m) => {
      const slot = monthMap.get(m)!;
      return { month: m, avg: slot.sum / slot.n };
    });
  if (monthData.length === 0) return null;
  const maxAbs = Math.max(...monthData.map((d) => Math.abs(d.avg)), 1);

  const W = 800;
  const H = 200;
  const padL = 40;
  const padR = 10;
  const padT = 10;
  const padB = 40;
  const barWidth = Math.max(8, (W - padL - padR) / monthData.length - 4);
  const midY = padT + (H - padT - padB) / 2;
  const yScale = (v: number) => midY - (v / maxAbs) * ((H - padT - padB) / 2);

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">
        {dailyMonths ? "月度帳戶報酬" : "各月平倉交易平均價差"}
      </h2>
      <p className="mb-2 text-xs text-slate-400">
        {dailyMonths
          ? "依月末帳戶淨值計算，含未平倉估值；首尾月份可能未滿整月。"
          : "未扣成本的逐筆平均，並非整體帳戶月報酬。"}
      </p>
      <div className="rounded-2xl border border-line bg-surface-1 p-4">
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="text-xs">
          <line x1={padL} x2={W - padR} y1={midY} y2={midY} stroke="#52525b" />
          {monthData.map((d, i) => {
            const x = padL + i * ((W - padL - padR) / monthData.length) + 2;
            const y = d.avg >= 0 ? yScale(d.avg) : midY;
            const h = Math.abs(midY - yScale(d.avg));
            // 台股配色:紅 = 漲,綠 = 跌
            const cls = d.avg >= 0 ? "fill-red-500" : "fill-green-500";
            return (
              <g key={d.month}>
                <rect x={x} y={y} width={barWidth} height={h} className={cls} />
                <title>{`${d.month}: ${d.avg >= 0 ? "+" : ""}${d.avg.toFixed(2)}%`}</title>
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
      <TableShell>
        <table className="w-full text-sm">
          <THead>
            <tr>
              <th className="px-3 py-2">股號</th>
              <th className="px-3 py-2 text-right">Rank</th>
              <th className="px-3 py-2">進場日</th>
              <th className="px-3 py-2 text-right">進場價</th>
              <th className="px-3 py-2">出場日</th>
              <th className="px-3 py-2 text-right">出場價</th>
              <th className="px-3 py-2 text-right">價差（未扣成本）</th>
            </tr>
          </THead>
          <tbody>
            {top.map((t) => (
              <tr
                key={t.id}
                className={`border-t border-line-soft ${t.is_benchmark ? "bg-surface-raised" : ""}`}
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
                <td className="px-3 py-2 text-xs text-zinc-300">
                  {t.entry_date}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtMoney(t.entry_price, 2)}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-300">
                  {t.exit_date}
                </td>
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
      </TableShell>
    </section>
  );
}
