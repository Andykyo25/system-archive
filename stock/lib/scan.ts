export interface ScanRow {
  symbol: string;
  name: string | null;
  industry_category: string | null;
  trade_date: string;
  close: number | null;
  day_pct: number | null;
  volume_lots: number | null;
  ma20: number | null;
  ma20_gap_pct: number | null;
  ma20_slope_pct: number | null;
  high_20d: number | null;
  rsi14: number | null;
  ret_5d_pct: number | null;
  score_surge: number | null;
  score_position: number | null;
  score_momentum: number | null;
  score_total: number | null;
  passes_all: boolean | null;
  fgn_net_5d: number | null;
  atr14: number | null;
}

export function conditions(r: ScanRow) {
  return [
    { label: "當日漲幅 ≥ 7%", pass: r.day_pct != null && r.day_pct >= 7 },
    {
      label: "成交量 ≥ 5,000 張",
      pass: r.volume_lots != null && r.volume_lots >= 5000,
    },
    {
      label: "突破前 20 日高",
      pass: r.close != null && r.high_20d != null && r.close > r.high_20d,
    },
    {
      label: "站上轉揚月線",
      pass:
        r.close != null &&
        r.ma20 != null &&
        r.close > r.ma20 &&
        r.ma20_slope_pct != null &&
        r.ma20_slope_pct > 0,
    },
    {
      label: "月線乖離 < 15%",
      pass: r.ma20_gap_pct != null && r.ma20_gap_pct < 15,
    },
  ];
}

export interface Observation {
  scan_date: string;
  horizon: number;
  strategy_version: string | null;
  excess_pct: number | null;
  observation_status: string;
}

// Equal weight each scan DAY; a day with many correlated picks must not dominate.
export function summarizeObservations(rows: Observation[]) {
  const settled = rows.filter(
    (r) =>
      r.observation_status === "settled" &&
      r.excess_pct != null &&
      Number.isFinite(Number(r.excess_pct)),
  );
  const days = new Map<string, number[]>();
  for (const r of settled)
    days.set(r.scan_date, [
      ...(days.get(r.scan_date) ?? []),
      Number(r.excess_pct),
    ]);
  const means = [...days.values()].map(
    (xs) => xs.reduce((a, b) => a + b, 0) / xs.length,
  );
  return {
    settled: settled.length,
    days: means.length,
    mean: means.length ? means.reduce((a, b) => a + b, 0) / means.length : null,
    pending: rows.filter((r) => r.observation_status === "pending").length,
    missing: rows.filter(
      (r) => !["pending", "settled"].includes(r.observation_status),
    ).length,
  };
}
