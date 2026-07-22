import { fmtMoney, fmtPct, pctColor } from "./Format";

// 「我的交易表現」widget — Dashboard 用
//
// 資料源:
//   v_holdings_summary(total_realized_pnl / total_invested / count_closed / ...)
//   v_holdings_realized(每筆 SELL row,含 realized_pnl / realized_pct / sell_date)
//   holdings_transactions(BUY rows 算每檔首次買入日 → 持有天數)
//
// 顯示:
//   左上 3 大數字:已實現損益 / 勝率 / 累積報酬%
//   右 5 筆最近平倉(symbol / % / 持有天數)
//   底部 平均報酬% + 平均持有天數 + 最大單筆獲利

export interface PerfSummary {
  total_realized_pnl: number | string | null;
  total_invested: number | string | null;
  count_closed: number | string | null;
}

export interface PerfRealizedRow {
  symbol: string;
  sell_date: string;
  realized_pnl: number | string | null;
  realized_pct: number | string | null;
  qty_sold: number | string | null;
  avg_cost_at_sell: number | string | null; // A1 移動均價(賣出當下),算精確 cost basis 用
  first_buy_date: string | null; // join 進來的
}

function daysBetween(a: string | null, b: string): number | null {
  if (!a) return null;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.max(0, Math.round((tb - ta) / 86400000));
}

export function PerformanceWidget({
  summary,
  realized,
}: {
  summary: PerfSummary | null;
  realized: PerfRealizedRow[];
}) {
  const totalRealized = Number(summary?.total_realized_pnl ?? 0);
  const totalInvested = Number(summary?.total_invested ?? 0);

  const wins = realized.filter((r) => Number(r.realized_pnl) > 0).length;
  const total = realized.length;
  const winRate = total > 0 ? (wins / total) * 100 : null;

  // 兩個視角:
  //   avgPct  = 平均單筆報酬 mean(realized_pct)  → 簡單平均
  //   wgtPct  = 加權報酬 sum(pnl) / sum(cost)    → 反映「整體做出多少 %」
  //
  // 「累積報酬率」用加權版才合理(大部位 weight 大),小卡顯示加權,
  // 副標寫出平均單筆讓兩個視角都看得到。
  const pcts = realized
    .map((r) => Number(r.realized_pct))
    .filter((v) => Number.isFinite(v));
  const avgPct = pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;

  // 加權累積報酬 = sum(淨 pnl) / sum(真實成本基數)。
  //   成本基數 = avg_cost_at_sell × qty_sold(A1 修後 v_holdings_realized 提供賣出當下
  //   移動均價,精確)。舊版用「淨 pnl ÷ 毛 pct」反推 → 分子已扣 fee/tax、分母沒扣,
  //   口徑不一致使 sumCost 偏小、cumulativePct 系統性高估(A4 修)。
  let sumPnl = 0;
  let sumCost = 0;
  for (const r of realized) {
    const pnl = Number(r.realized_pnl);
    const avgCost = Number(r.avg_cost_at_sell);
    const qty = Number(r.qty_sold);
    if (!Number.isFinite(pnl) || !Number.isFinite(avgCost) || !Number.isFinite(qty)) continue;
    const cost = avgCost * qty;
    if (cost <= 0) continue;
    sumPnl += pnl;
    sumCost += cost;
  }
  const cumulativePct = sumCost > 0 ? (sumPnl / sumCost) * 100 : avgPct;

  const maxGainRow = realized.reduce(
    (best, cur) => {
      const v = Number(cur.realized_pct);
      if (!Number.isFinite(v)) return best;
      if (best == null || v > Number(best.realized_pct)) return cur;
      return best;
    },
    null as PerfRealizedRow | null,
  );

  const holdDays = realized
    .map((r) => daysBetween(r.first_buy_date, r.sell_date))
    .filter((d): d is number => d != null);
  const avgHoldDays =
    holdDays.length > 0
      ? Math.round(holdDays.reduce((a, b) => a + b, 0) / holdDays.length)
      : null;

  return (
    <section className="rounded-2xl border border-line bg-surface-1">
      <header className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h2 className="text-base font-semibold text-zinc-100">
          我的交易表現
        </h2>
        <span className="text-xs text-zinc-500">
          已平倉 {total} 檔
        </span>
      </header>

      {total === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-zinc-500">
          尚無已平倉紀錄。賣出後此區自動統計勝率、累積報酬與持有天數。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3">
          <div className="md:col-span-2">
            <div className="grid grid-cols-3 gap-3">
              <BigStat
                label="已實現損益"
                value={fmtMoney(totalRealized, 0)}
                color={pctColor(totalRealized || null)}
                sub={`投入 ${fmtMoney(totalInvested, 0)}`}
              />
              <BigStat
                label="勝率"
                value={`${wins}/${total}`}
                color={
                  winRate != null && winRate >= 60
                    ? "text-red-400"
                    : "text-zinc-200"
                }
                sub={winRate != null ? `${winRate.toFixed(0)}%` : "—"}
              />
              <BigStat
                label="累積報酬率"
                value={fmtPct(cumulativePct)}
                color={pctColor(cumulativePct)}
                sub={
                  avgPct != null
                    ? `平均單筆 ${fmtPct(avgPct)}`
                    : "—"
                }
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
              <Mini
                label="平均持有天數"
                value={avgHoldDays != null ? `${avgHoldDays} 天` : "—"}
              />
              <Mini
                label="最大單筆獲利"
                value={
                  maxGainRow
                    ? `${maxGainRow.symbol} ${fmtPct(maxGainRow.realized_pct)}`
                    : "—"
                }
                color={pctColor(maxGainRow?.realized_pct ?? null)}
              />
            </div>
          </div>

          <div className="md:col-span-1">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              最近 {Math.min(5, total)} 筆平倉
            </h3>
            <ul className="space-y-1.5">
              {realized.slice(0, 5).map((r, idx) => {
                const days = daysBetween(r.first_buy_date, r.sell_date);
                return (
                  <li
                    key={`${r.symbol}-${r.sell_date}-${idx}`}
                    className="flex items-center justify-between rounded-xl border border-line bg-surface-sunken px-2.5 py-1.5 text-xs"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="font-mono text-zinc-300">
                        {r.symbol}
                      </span>
                      <span className="truncate text-zinc-600">
                        {r.sell_date}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 tabular-nums">
                      {days != null && (
                        <span className="text-zinc-500">{days}d</span>
                      )}
                      <span
                        className={`font-semibold ${pctColor(r.realized_pct)}`}
                      >
                        {fmtPct(r.realized_pct)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function BigStat({
  label,
  value,
  color = "",
  sub,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className={`mt-0.5 text-2xl font-semibold tabular-nums ${color}`}>
        {value}
      </div>
      {sub && (
        <div className="text-[11px] tabular-nums text-zinc-500">{sub}</div>
      )}
    </div>
  );
}

function Mini({
  label,
  value,
  color = "",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface-sunken px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className={`mt-0.5 text-sm font-medium tabular-nums ${color}`}>
        {value}
      </div>
    </div>
  );
}
