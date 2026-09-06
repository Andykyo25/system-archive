export interface CurveSummary {
  execution_version?: string;
  accounting_version?: string;
  equity_dates?: string[];
  rebalance_dates?: string[];
  equity_curve?: number[];
  benchmark_equity_curve?: number[];
}

// Legacy curves have inconsistent node/date counts. Never label daily points
// with rebalance dates or overlay curves from different accounting models.
export function canOverlay(
  runs: {
    summary: CurveSummary | null;
    params: { benchmark_symbol: string };
  }[],
) {
  if (!runs.length) return false;
  const signature = (run: (typeof runs)[number]) => {
    const s = run.summary;
    const dates = s?.equity_dates ?? s?.rebalance_dates;
    if (
      !dates?.length ||
      dates.length !== s?.equity_curve?.length ||
      dates.length !== s?.benchmark_equity_curve?.length
    )
      return null;
    return JSON.stringify([
      s.execution_version ?? "legacy",
      s.accounting_version ?? "legacy",
      run.params.benchmark_symbol,
      dates,
      s.benchmark_equity_curve,
    ]);
  };
  const first = signature(runs[0]);
  return first !== null && runs.every((run) => signature(run) === first);
}

export function monthlyEquityReturns(
  summary: CurveSummary,
): { month: string; avg: number }[] | null {
  const { equity_dates: dates, equity_curve: equity } = summary;
  if (!dates?.length || dates.length !== equity?.length) return null;
  const endpoints = new Map<string, number>();
  dates.forEach((date, i) => endpoints.set(date.slice(0, 7), equity[i]));
  let previous = 1;
  return Array.from(endpoints, ([month, end]) => {
    const avg = (end / previous - 1) * 100;
    previous = end;
    return { month, avg };
  });
}
