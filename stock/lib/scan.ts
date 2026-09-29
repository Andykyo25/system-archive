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

// v_scan_verdict:R2p(2026-09-29)—— 候選 score ≥ 80 中,距 60 日收盤高 > −5%、上方套牢 ≤ 10%、
// 0050 在季線上,依分數取前 3 檔。依據 tools/scan-backtest/r2p.mjs(2023–2026 勝率 56%)。
// 原本的型態 A + 滾動 60 掃描日信心標籤已移除:型態 A 3.7 年僅 47.5%,滾動勝率對下一段無預測力。
export interface VerdictRow extends ScanRow {
  // 收盤距 60 日最高收盤的 %(≤ 0)
  off_hi60: number | string | null;
  // 過去 120 日在「收盤價~+20%」的成交量佔比(上方套牢量),0~1
  supply_share: number | string | null;
  // 0050 還原價距季線 %
  market_ma60_pct: number | string | null;
}

// 回測的出場規格;停損倍數在 app_settings.verdict_atr_stop_multiple(資料庫凍結價位也讀它)。
export const VERDICT_EXIT = { takeProfitPct: 10, maxHoldDays: 20 } as const;

// v_verdict_live:盤中閘門(今日曾跌破停損 → 當日持續停止;2026-09-24 起不再推播)
export interface VerdictLive {
  symbol: string;
  state: "ok" | "block" | "wait";
  reason: string | null;
  price_now: number | string | null;
  quoted_at: string | null;
}

// 寫進交易計畫的進場理由:R2p 三條件的實際數值 + 回測出處。
export function verdictEvidence(r: VerdictRow): string {
  const supply =
    r.supply_share == null ? "" : `上方套牢 ${(Number(r.supply_share) * 100).toFixed(0)}%，`;
  return `系統看多：距 60 日高 ${Number(r.off_hi60).toFixed(1)}%，${supply}0050 在季線上（2023–2026 回測勝率 56%）。`;
}
