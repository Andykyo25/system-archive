// 選股成績單(/track)的純函式。資料來源 mv_pick_scorecard,一列 = 一次挑選。
// supabase numeric 回字串([[L13]]),進來一律先 toNum。

export type TrackSystem = "scan" | "swing" | "rank" | "mine";
export type Verdict = "win" | "lag" | "up" | "loss" | "pending";
export type Horizon = 5 | 10 | 20;

type Num = number | string | null;

export interface PickRow {
  system: TrackSystem;
  pick_id: string;
  pick_date: string;
  symbol: string;
  name: string | null;
  score: Num;
  pick_rank: number | null;
  tag: string | null;
  entry_px: Num;
  ret_5: Num;
  ret_10: Num;
  ret_20: Num;
  exc_5: Num;
  exc_10: Num;
  exc_20: Num;
  verdict_h: number | null;
  verdict_ret: Num;
  verdict_exc: Num;
  verdict: Verdict;
  refreshed_at: string;
}

// 口徑(詳見 migration 20260923000002 註解;報酬皆未扣成本):
//   scan  隔一交易日收盤進場、還原價,基準 = 同日收盤 ≥20 元全市場等權
//   swing 同上但未還原價
//   rank  凍結 top10,20 交易日結算,基準 = 同批 0050(8/15、9/12 兩批混入 ETF)
//   mine  實際成交價起算(非賣出損益),基準同 scan
export const SYSTEMS: Record<
  TrackSystem,
  { label: string; horizons: Horizon[] }
> = {
  scan: { label: "起漲掃描", horizons: [5, 10, 20] },
  swing: { label: "回檔波段", horizons: [5, 20] },
  rank: { label: "多因子排名", horizons: [20] },
  mine: { label: "我的買進", horizons: [5, 10, 20] },
};

export const VERDICT: Record<Verdict, { label: string; icon: string }> = {
  win: { label: "漲且贏大盤", icon: "✅" },
  lag: { label: "漲但輸大盤", icon: "⚠️" },
  up: { label: "漲（無基準）", icon: "✅" },
  loss: { label: "跌", icon: "❌" },
  pending: { label: "未到期", icon: "⏳" },
};

export function toNum(v: Num | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

const pct = (hit: number, n: number) => (n ? (hit / n) * 100 : null);

export function retAt(r: PickRow, h: Horizon): number | null {
  return toNum(h === 5 ? r.ret_5 : h === 10 ? r.ret_10 : r.ret_20);
}

export function excAt(r: PickRow, h: Horizon): number | null {
  return toNum(h === 5 ? r.exc_5 : h === 10 ? r.exc_10 : r.exc_20);
}

// 同一天期才放在一起比([[L67]]:不同觀察視野不可混在同一個平均裡)。
export function horizonStats(rows: PickRow[], h: Horizon) {
  const settled = rows.filter((r) => retAt(r, h) != null);
  if (settled.length === 0) return null;
  const rets = settled.map((r) => retAt(r, h) as number);
  const excs = settled
    .map((r) => excAt(r, h))
    .filter((x): x is number => x != null);
  return {
    n: settled.length,
    days: new Set(settled.map((r) => r.pick_date)).size,
    upPct: pct(rets.filter((x) => x > 0).length, rets.length),
    beatPct: pct(excs.filter((x) => x > 0).length, excs.length),
    meanRet: mean(rets),
    medianRet: median(rets),
    meanExc: mean(excs),
    medianExc: median(excs),
  };
}

export function verdictCounts(rows: PickRow[]): Record<Verdict, number> {
  const c: Record<Verdict, number> = { win: 0, lag: 0, up: 0, loss: 0, pending: 0 };
  for (const r of rows) c[r.verdict] += 1;
  return c;
}

export type TrackSort = "recent" | "best" | "worst";

export function sortPicks(rows: PickRow[], sort: TrackSort): PickRow[] {
  const out = [...rows];
  if (sort === "recent") {
    return out.sort(
      (a, b) =>
        b.pick_date.localeCompare(a.pick_date) || a.symbol.localeCompare(b.symbol),
    );
  }
  // 未到期的永遠排在最後,不讓 null 混進最好 / 最差。
  return out.sort((a, b) => {
    const x = toNum(a.verdict_ret);
    const y = toNum(b.verdict_ret);
    if (x == null && y == null) return b.pick_date.localeCompare(a.pick_date);
    if (x == null) return 1;
    if (y == null) return -1;
    return sort === "best" ? y - x : x - y;
  });
}
