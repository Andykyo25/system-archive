import { Fragment } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { unstable_cache } from "next/cache";
import { unwrap } from "@/lib/db";
import { fmtMoney, fmtPct, pctColor } from "./_components/Format";
import { PriceCell } from "./_components/PriceCell";
import { analyzeRow, summarizeForRow } from "./_components/Analyze";
import {
  PerformanceWidget,
  type PerfRealizedRow,
  type PerfSummary,
} from "./_components/PerformanceWidget";
import {
  AdviceWidget,
  type AdvicePickRow,
} from "./_components/AdviceWidget";
import {
  OverseasWidget,
  type OverseasRow,
} from "./_components/OverseasWidget";

export const dynamic = "force-dynamic";

interface PortfolioSummary {
  positions: number;
  total_cost: number | string;
  total_value: number | string;
  total_pnl: number | string;
  total_pct: number | string;
  net_total_cost: number | string;
  net_total_value: number | string;
  net_total_pnl: number | string;
  net_total_pct: number | string;
}

interface HoldingFull {
  symbol: string;
  qty: number | string;
  avg_cost: number | string;
  current_price: number | string | null;
  price_date: string | null;
  is_provisional: boolean | null;
  as_of_ts: string | null;
  price_source: string | null;
  market_state: string | null;
  unrealized_pnl: number | string | null;
  unrealized_pct: number | string | null;
  market_value: number | string | null;
  cost_basis: number | string;
  stock_type: "stock" | "etf";
  total_cost_with_fee: number | string;
  net_proceeds_if_sold_now: number | string | null;
  net_pnl_est: number | string | null;
  net_pct_est: number | string | null;
  primary_industry: string | null;
  eps_ttm: number | string | null;
  eps_yoy_pct: number | string | null;
  last_q_eps_yoy_pct: number | string | null;
  avg_q_eps_yoy_pct?: number | string | null;
  roe_ttm: number | string | null;
  fcf_ttm: number | string | null;
  gross_margin_pct: number | string | null;
  gross_margin_yoy_pp: number | string | null;
  pe: number | string | null;
  pb: number | string | null;
  peg: number | string | null;
  peg_basis: string | null;
  pb_threshold: number | string | null;
  latest_revenue_period: number | null;
  latest_revenue: number | string | null;
  latest_revenue_yoy_pct: number | string | null;
  score: number;
}

interface EntrySignalSummary {
  symbol: string;
  weighted_score: number | string | null;
  expected_rank: number;
  signal_strength: "strong" | "normal" | "none" | "insufficient_data";
  fund_count_pos: number;
  fund_count_total: number;
  mom_count_pos: number;
  mom_count_total: number;
  chip_count_pos: number;
  chip_count_total: number;
}

// 持股的 19 因子綜合判斷(餵「真實持股」表,讓基本面 score 旁也顯示綜合排名 + 進場燈)
interface HeldRank {
  symbol: string;
  expected_rank: number | null;
  weighted_score: number | string | null;
  is_entry_signal: boolean | null;
  signal_strength: "strong" | "normal" | "none" | "insufficient_data" | null;
  fund_count_pos: number | null;
  fund_count_total: number | null;
  mom_count_pos: number | null;
  mom_count_total: number | null;
  chip_count_pos: number | null;
  chip_count_total: number | null;
}

function scoreClass(score: number): string {
  if (score >= 6) return "bg-green-600 text-white";
  if (score >= 5) return "bg-green-700 text-white";
  if (score >= 4) return "bg-green-800 text-green-100";
  if (score >= 3) return "bg-yellow-800 text-yellow-100";
  if (score >= 2) return "bg-orange-900 text-orange-200";
  if (score >= 1) return "bg-zinc-800 text-zinc-300";
  return "bg-zinc-900 text-zinc-500";
}

function fmtRoe(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}

function fmtFcf(n: string | number | null | undefined): {
  text: string;
  cls: string;
  title: string;
} {
  if (n == null) return { text: "—", cls: "text-zinc-600", title: "FCF 無資料" };
  const v = Number(n);
  if (!Number.isFinite(v)) return { text: "—", cls: "text-zinc-600", title: "—" };
  const title = `FCF (TTM) = ${v.toLocaleString()}`;
  if (v > 0) return { text: "+", cls: "text-red-400", title };
  return { text: "−", cls: "text-green-400", title };
}

function pbCellClass(
  pb: number | string | null | undefined,
  threshold: number | string | null | undefined,
): string {
  if (pb == null || threshold == null) return "text-zinc-400";
  const pbN = Number(pb);
  const thN = Number(threshold);
  if (!Number.isFinite(pbN) || !Number.isFinite(thN)) return "text-zinc-400";
  return pbN < thN ? "text-red-400" : "text-zinc-400";
}

function buildScoreTooltip(analysis: { headline: string; notes: string[] }): string {
  return [analysis.headline, "", ...analysis.notes].join("\n");
}

interface RankPick {
  symbol: string;
  weighted_score: number | string | null;
  fund_count_pos: number;
  fund_count_total: number;
  expected_rank: number;
}

// === 慢變資料快取 ===
// dashboard 是 force-dynamic,每次 render 並發 ~11 個 DB 查詢;高頻刷新時把
// PostgREST 連線池打爆(statement / pool timeout)。把「與即時報價/持股無關」的
// 慢變查詢(進場訊號 / 排名 / 名稱對照,皆日更或 cron 級)用 unstable_cache 快取,
// 高頻 render 命中快取不打 DB,連線並發降到只剩即時查詢(報價/損益/持股)。
// 報價/損益維持每次即時;買賣經 holdings action revalidatePath('/') 一併刷新;
// 排名/名稱最多舊 60~300s,對日更資料無感。server.ts 用 service_role 無 cookies,
// 可安全在 cache scope 內 createClient(unstable_cache 限制:scope 內不可用 cookies)。
const getCachedEntrySignals = unstable_cache(
  async (): Promise<EntrySignalSummary[]> => {
    const sb = createClient();
    const { data } = await sb
      .from("v_entry_signal")
      .select(
        "symbol, weighted_score, expected_rank, signal_strength, fund_count_pos, fund_count_total, mom_count_pos, mom_count_total, chip_count_pos, chip_count_total, is_entry_signal",
      )
      .eq("is_entry_signal", true)
      .order("weighted_score", { ascending: false, nullsFirst: false })
      .limit(10);
    return (data as EntrySignalSummary[] | null) ?? [];
  },
  ["dashboard:entry-signals"],
  { revalidate: 60 },
);

const getCachedTopRanks = unstable_cache(
  async (): Promise<RankPick[]> => {
    const sb = createClient();
    const { data } = await sb
      .from("v_stock_rank")
      .select(
        "symbol, weighted_score, fund_count_pos, fund_count_total, expected_rank",
      )
      .gte("fund_count_pos", 5)
      .order("expected_rank", { ascending: true })
      .limit(30);
    return (data as RankPick[] | null) ?? [];
  },
  ["dashboard:top-ranks"],
  { revalidate: 60 },
);

const getCachedNames = unstable_cache(
  async (): Promise<{
    nameMap: Record<string, string | null>;
    industryMap: Record<string, string | null>;
  }> => {
    const sb = createClient();
    const [is, su, em] = await Promise.all([
      sb.from("industry_stocks").select("symbol, name, industry"),
      sb.from("stock_universe").select("symbol, name"),
      sb.from("etf_metadata").select("symbol, name"),
    ]);
    const nameMap: Record<string, string | null> = {};
    const industryMap: Record<string, string | null> = {};
    for (const r of (em.data as { symbol: string; name: string | null }[] | null) ?? []) {
      if (r.name) nameMap[r.symbol] = r.name;
    }
    for (const r of (su.data as { symbol: string; name: string | null }[] | null) ?? []) {
      if (!nameMap[r.symbol] && r.name) nameMap[r.symbol] = r.name;
    }
    for (const r of (is.data as
      | { symbol: string; name: string | null; industry: string | null }[]
      | null) ?? []) {
      if (!nameMap[r.symbol] && r.name) nameMap[r.symbol] = r.name;
      if (r.industry) industryMap[r.symbol] = r.industry;
    }
    return { nameMap, industryMap };
  },
  ["dashboard:names"],
  { revalidate: 300 },
);

// 海外隔夜領先(11 源,cron 一天只更新 2 次:06:30/08:30 Taipei)→ 300s 快取綽綽有餘。
// 各源最新日期不同(美股=前一交易日 bar、NQ=F/VIX 期貨=即時)→ 拉近 7 天再各取最新一筆。
const getCachedOverseas = unstable_cache(
  async (): Promise<OverseasRow[]> => {
    const sb = createClient();
    const since = new Date(Date.now() - 7 * 86400_000)
      .toISOString()
      .slice(0, 10);
    const { data } = await sb
      .from("overseas_indicators")
      .select("symbol, quoted_date, last_price, prev_close, change_pct")
      .gte("quoted_date", since)
      .order("quoted_date", { ascending: false });
    const latest = new Map<string, OverseasRow>();
    for (const r of (data as OverseasRow[] | null) ?? []) {
      if (!latest.has(r.symbol)) latest.set(r.symbol, r); // 已按日期 desc,首見即最新
    }
    return [...latest.values()];
  },
  ["dashboard:overseas"],
  { revalidate: 300 },
);

// Regime 燈(U 型濾網產品化,2026-05-20 發現):策略 alpha vs 0050 季報酬呈 U 型 —
// bench<0 / ≥20% 兩端 alpha +8.84/+3.76(歷史全勝),10-20% 中段 −8.70(全敗)= 地雷區。
// 資料:0050 近 61 筆收盤(adj)≈ 一季。⚠ 樣本僅 2023-2025 12 季,需 paper-track 驗真。
const getCachedRegime = unstable_cache(
  async (): Promise<number | null> => {
    const sb = createClient();
    const { data } = await sb
      .from("price_daily")
      .select("close, adj_factor")
      .eq("symbol", "0050")
      .gt("close", 0)
      .order("trade_date", { ascending: false })
      .limit(61);
    const rows =
      (data as { close: number | string; adj_factor: number | string | null }[] | null) ?? [];
    if (rows.length < 61) return null;
    const adj = (r: (typeof rows)[number]) =>
      Number(r.close) * Number(r.adj_factor ?? 1);
    const last = adj(rows[0]);
    const base = adj(rows[60]);
    return base > 0 ? (last / base - 1) * 100 : null;
  },
  ["dashboard:regime"],
  { revalidate: 3600 },
);

function RegimeWidget({ ret }: { ret: number | null }) {
  if (ret == null) return null;
  const zone =
    ret < 0
      ? { label: "歷史有利區(跌勢)", cls: "text-green-400", note: "策略季 alpha 歷史 +8.84(全勝)" }
      : ret < 10
        ? { label: "中性區", cls: "text-zinc-300", note: "無顯著歷史傾向" }
        : ret < 20
          ? { label: "⚠ 策略地雷區", cls: "text-orange-400", note: "歷史季 alpha −8.70(全敗):主動減碼/改 0050" }
          : { label: "歷史有利區(強漲)", cls: "text-green-400", note: "策略季 alpha 歷史 +3.76(全勝)" };
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2 text-sm">
      <span className="text-zinc-400">Regime</span>
      <span className="tabular-nums">
        0050 近季 {ret >= 0 ? "+" : ""}
        {ret.toFixed(1)}%
      </span>
      <span className={`font-medium ${zone.cls}`}>{zone.label}</span>
      <span className="text-xs text-zinc-500">
        {zone.note} · U 型濾網僅 12 季樣本,paper-track 驗真中
      </span>
    </div>
  );
}

export default async function Dashboard() {
  const sb = createClient();
  // 即時查詢:報價 / 損益 / 持股,每次 render 要最新,不快取
  const [
    summaryR,
    holdingsR,
    { data: perfSummary },
    { data: realizedRows },
    { data: buyTxns },
  ] = await Promise.all([
    sb.from("v_portfolio_summary").select("*").single(),
    sb
      .from("v_holdings_full")
      .select("*")
      .order("market_value", { ascending: false, nullsFirst: false }),
    sb
      .from("v_holdings_summary")
      .select("total_realized_pnl, total_invested, count_closed")
      .single(),
    sb
      .from("v_holdings_realized")
      .select("symbol, sell_date, realized_pnl, realized_pct, qty_sold, avg_cost_at_sell")
      .order("sell_date", { ascending: false })
      .order("created_at", { ascending: false }),
    sb
      .from("holdings_transactions")
      .select("symbol, txn_date")
      .eq("txn_type", "BUY")
      .order("txn_date", { ascending: true }),
  ]);

  // 核心 query 失敗 → throw 到 app/error.tsx,不靜默變空表(A3/L42),fail-fast
  const summary = unwrap(summaryR, "v_portfolio_summary");
  const holdings = unwrap(holdingsR, "v_holdings_full");

  // 慢變查詢走快取(進場訊號 / 排名 / 名稱對照),高頻 render 命中快取不打 DB,
  // 大幅降低連線並發(根因緩解 dashboard 高頻 PostgREST 連線池 timeout)
  const [signalRows, rankRowsRaw, names, overseasRows, regimeRet] = await Promise.all([
    getCachedEntrySignals(),
    getCachedTopRanks(),
    getCachedNames(),
    getCachedOverseas(),
    getCachedRegime(),
  ]);
  const { nameMap, industryMap } = names;

  // 「真實持股」表也顯示系統綜合判斷:持股的 expected_rank + 進場燈。
  // 動機:基本面 6 條 score 對景氣循環股(如記憶體)反轉初期偏嚴 → score 低
  // 但 19 因子綜合排名可能很前面 + 進場燈亮。並列兩者避免被單一 score 誤導。
  const holdingRows = (holdings as HoldingFull[] | null) ?? [];
  const heldRankMap: Record<string, HeldRank> = {};
  if (holdingRows.length > 0) {
    const { data: heldRanks } = await sb
      .from("v_entry_signal")
      .select(
        "symbol, expected_rank, weighted_score, is_entry_signal, signal_strength, fund_count_pos, fund_count_total, mom_count_pos, mom_count_total, chip_count_pos, chip_count_total",
      )
      .in(
        "symbol",
        holdingRows.map((h) => h.symbol),
      );
    for (const r of (heldRanks as HeldRank[] | null) ?? []) {
      heldRankMap[r.symbol] = r;
    }
  }

  // 持股表現 widget 預備:realized rows + 每 symbol first BUY date
  const firstBuyMap = new Map<string, string>();
  for (const t of (buyTxns as { symbol: string; txn_date: string }[] | null) ?? []) {
    if (!firstBuyMap.has(t.symbol)) firstBuyMap.set(t.symbol, t.txn_date);
  }

  const perfRealized: PerfRealizedRow[] =
    (
      (realizedRows as
        | {
            symbol: string;
            sell_date: string;
            realized_pnl: number | string | null;
            realized_pct: number | string | null;
            qty_sold: number | string | null;
            avg_cost_at_sell: number | string | null;
          }[]
        | null) ?? []
    ).map((r) => ({
      ...r,
      first_buy_date: firstBuyMap.get(r.symbol) ?? null,
    }));

  // 持有中的 symbol → 排除掉(可關注標的不該推「已經持有的」)
  const heldSymbols = new Set(holdingRows.map((h) => h.symbol));
  const advicePicks: AdvicePickRow[] = rankRowsRaw
    .filter((r) => !heldSymbols.has(r.symbol))
    .map((r) => ({
      symbol: r.symbol,
      name: nameMap[r.symbol] ?? null,
      weighted_score: r.weighted_score,
      fund_count_pos: r.fund_count_pos,
      fund_count_total: r.fund_count_total,
      industry: industryMap[r.symbol] ?? null,
    }));

  // 海外快照的持股對應源高亮:持股 symbol → industry(getCachedNames 的 industryMap)
  const overseasHoldings = holdingRows.map((h) => ({
    symbol: h.symbol,
    industry: industryMap[h.symbol] ?? h.primary_industry ?? null,
  }));

  return (
    <div className="space-y-6">
      <SummaryCards summary={summary as PortfolioSummary | null} />
      <RegimeWidget ret={regimeRet} />
      <OverseasWidget rows={overseasRows} holdings={overseasHoldings} />
      <PerformanceWidget
        summary={perfSummary as PerfSummary | null}
        realized={perfRealized}
      />
      <AdviceWidget picks={advicePicks} />
      <EntrySignalWidget rows={signalRows} nameMap={nameMap} />
      <HoldingsAnalysis rows={holdingRows} rankMap={heldRankMap} />
    </div>
  );
}

function EntrySignalWidget({
  rows,
  nameMap,
}: {
  rows: EntrySignalSummary[];
  nameMap: Record<string, string | null>;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">
          今日進場訊號{" "}
          <span className="text-sm font-normal text-zinc-500">
            ({rows.length} 檔)
          </span>
        </h2>
        <Link
          href="/rank"
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          看完整排名 →
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
          <p>目前沒有進場訊號</p>
          <p className="mt-1 text-xs text-zinc-600">
            factor 資料累積中(籌碼 / 動能 / 基本面對齊條件)。
            等 cron 連跑 3-5 天後此區會自動填入。
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-right">#</th>
                <th className="px-3 py-2">股號</th>
                <th className="px-3 py-2">名稱</th>
                <th className="px-3 py-2 text-right">總分</th>
                <th className="px-3 py-2 text-center">強度</th>
                <th className="px-3 py-2 text-right">基本面</th>
                <th className="px-3 py-2 text-right">動能</th>
                <th className="px-3 py-2 text-right">籌碼</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const strong = s.signal_strength === "strong";
                return (
                  <tr key={s.symbol} className="border-t border-zinc-800">
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                      {s.expected_rank}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      <Link
                        href={`/stocks/${s.symbol}`}
                        className="text-blue-400 hover:text-blue-300 hover:underline"
                      >
                        {s.symbol}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-zinc-300">
                      {nameMap[s.symbol] ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-semibold">
                        {fmtScore(s.weighted_score)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        title={`進場訊號:${s.signal_strength}`}
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${
                          strong
                            ? "bg-red-900/40 text-red-200"
                            : "bg-amber-900/40 text-amber-200"
                        }`}
                      >
                        {strong ? "⭐ 強" : "標準"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-blue-400">
                      <span title={`基本面 ${s.fund_count_pos}/${s.fund_count_total}`}>
                        {s.fund_count_pos}
                        <span className="text-zinc-600">/{s.fund_count_total}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-amber-400">
                      <span title={`動能 ${s.mom_count_pos}/${s.mom_count_total}`}>
                        {s.mom_count_pos}
                        <span className="text-zinc-600">/{s.mom_count_total}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-400">
                      <span title={`籌碼 ${s.chip_count_pos}/${s.chip_count_total}`}>
                        {s.chip_count_total === 0 ? (
                          <span className="text-zinc-600">—</span>
                        ) : (
                          <>
                            {s.chip_count_pos}
                            <span className="text-zinc-600">/{s.chip_count_total}</span>
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function fmtScore(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

function SummaryCards({ summary }: { summary: PortfolioSummary | null }) {
  if (!summary || Number(summary.positions) === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center">
        <p className="text-zinc-400">還沒有真實持股</p>
        <p className="mt-2 text-sm text-zinc-500">到「持股」tab 加一筆</p>
      </div>
    );
  }
  const grossPnl = Number(summary.total_pnl);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="持股檔數" value={String(summary.positions)} />
      <Stat
        label="總成本(含費)"
        value={fmtMoney(summary.net_total_cost, 0)}
        sub={`毛 ${fmtMoney(summary.total_cost, 0)}`}
      />
      <Stat
        label="預估賣出實得"
        value={fmtMoney(summary.net_total_value, 0)}
        sub={`毛市值 ${fmtMoney(summary.total_value, 0)}`}
      />
      <Stat
        label="未實現淨損益"
        value={fmtMoney(summary.net_total_pnl, 0)}
        sub={`${fmtPct(summary.net_total_pct)}　·　毛 ${fmtMoney(grossPnl, 0)}`}
        color={pctColor(summary.net_total_pnl)}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  color = "",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>
        {value}
      </div>
      {sub ? (
        <div className={`text-xs tabular-nums text-zinc-500 ${color ? "" : ""}`}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function HoldingsAnalysis({
  rows,
  rankMap,
}: {
  rows: HoldingFull[];
  rankMap: Record<string, HeldRank>;
}) {
  if (rows.length === 0) return null;
  const COL_COUNT = 13;
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">真實持股</h2>
        <span className="text-xs text-zinc-500">分數 hover 看完整分析,下方列出失分項目</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
            <tr>
              <th className="px-3 py-2">股號</th>
              <th className="px-3 py-2 text-center" title="上=基本面 6 條規則;下=19 因子綜合排名(⭐=進場訊號)">分 / 綜合</th>
              <th className="px-3 py-2 text-right">股數</th>
              <th className="px-3 py-2 text-right">均價</th>
              <th className="px-3 py-2 text-right">現價</th>
              <th className="px-3 py-2 text-right">市值</th>
              <th className="px-3 py-2 text-right" title="稅後預估淨損益">淨損益</th>
              <th className="px-3 py-2 text-right">淨%</th>
              <th className="px-3 py-2 text-right" title="最近一季 EPS YoY">EPS Q-YoY</th>
              <th className="px-3 py-2 text-right">ROE</th>
              <th className="px-3 py-2 text-center">FCF</th>
              <th className="px-3 py-2 text-right">PE</th>
              <th className="px-3 py-2 text-right">PB</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => {
              const fcf = fmtFcf(h.fcf_ttm);
              const pegYoy = h.last_q_eps_yoy_pct ?? h.eps_yoy_pct;
              const analysis = analyzeRow(h);
              const tooltip = buildScoreTooltip(analysis);
              const summary = summarizeForRow(analysis);
              const rank = rankMap[h.symbol];
              // 基本面 score 低但綜合排名靠前 + 進場燈 → 典型景氣循環股反轉初期
              // (基本面尺背著過去低谷;股價與綜合排名已反映復甦)。提示別只看 score。
              const cyclicalHint =
                h.score <= 3 &&
                rank?.expected_rank != null &&
                rank.expected_rank <= 30 &&
                rank.is_entry_signal === true;
              const grossPnl = Number(h.unrealized_pnl);
              const netPnl = Number(h.net_pnl_est);
              const feeDiff =
                Number.isFinite(grossPnl) && Number.isFinite(netPnl)
                  ? grossPnl - netPnl
                  : null;
              const netPnlTip =
                feeDiff != null
                  ? `毛損益 ${fmtMoney(grossPnl, 0)} − 手續費+稅 ${fmtMoney(feeDiff, 0)} = 淨損益 ${fmtMoney(netPnl, 0)}`
                  : "";
              return (
                <Fragment key={h.symbol}>
                <tr className="border-t border-zinc-800">
                  <td className="px-3 py-2 font-mono">
                    <Link href={`/stocks/${h.symbol}`} className="text-blue-400 hover:text-blue-300 hover:underline">
                      {h.symbol}
                    </Link>
                    {h.stock_type === "etf" && (
                      <span className="ml-1 rounded bg-blue-900 px-1 text-[10px] text-blue-200">ETF</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center" title={tooltip}>
                    <div className="flex flex-col items-center gap-0.5">
                      <span className={`cursor-help rounded px-2 py-0.5 text-xs font-semibold tabular-nums ${scoreClass(h.score)}`}>
                        {h.score}/6
                      </span>
                      {rank && (
                        <span
                          className="whitespace-nowrap text-[10px] text-zinc-400"
                          title={`19 因子綜合排名 #${rank.expected_rank ?? "—"}　·　基本面 ${rank.fund_count_pos ?? 0}/${rank.fund_count_total ?? 0}　·　動能 ${rank.mom_count_pos ?? 0}/${rank.mom_count_total ?? 0}　·　籌碼 ${rank.chip_count_total ? `${rank.chip_count_pos}/${rank.chip_count_total}` : "—"}`}
                        >
                          綜合{" "}
                          <span className="font-semibold text-zinc-200">
                            #{rank.expected_rank ?? "—"}
                          </span>
                          {rank.is_entry_signal && (
                            <span className="ml-0.5 text-yellow-400">⭐</span>
                          )}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{h.qty}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(h.avg_cost, 2)}</td>
                  <td className="px-3 py-2 text-right">
                    <PriceCell
                      value={h.current_price}
                      isProvisional={h.is_provisional}
                      date={h.price_date}
                      asOfTs={h.as_of_ts}
                      source={h.price_source}
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(h.market_value, 0)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${pctColor(h.net_pnl_est)}`} title={netPnlTip}>
                    {fmtMoney(h.net_pnl_est, 0)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${pctColor(h.net_pct_est)}`}>
                    {fmtPct(h.net_pct_est)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${pctColor(pegYoy)}`}>
                    {fmtPct(pegYoy)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtRoe(h.roe_ttm)}</td>
                  <td className={`px-3 py-2 text-center font-bold ${fcf.cls}`} title={fcf.title}>
                    {fcf.text}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(h.pe, 1)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${pbCellClass(h.pb, h.pb_threshold)}`} title={`產業門檻 < ${h.pb_threshold ?? "—"}`}>
                    {fmtMoney(h.pb, 2)}
                  </td>
                </tr>
                <tr className="border-t border-zinc-900/30 bg-zinc-950/30">
                  <td colSpan={COL_COUNT} className="px-3 pb-2 pt-1 text-[11px] leading-snug text-zinc-500">
                    {cyclicalHint && (
                      <span className="text-amber-400">
                        ⚠ 基本面分偏嚴(常見於景氣循環股反轉初期);系統綜合排名 #{rank.expected_rank} 靠前且進場燈亮,別只看 {h.score}/6 ·{" "}
                      </span>
                    )}
                    {summary}
                  </td>
                </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        「分」0-6 = 基本面 6 條:EPS 連 4 季正 / ROE&gt;15% / FCF&gt;0 / PEG&lt;1 / PB&lt;產業門檻 / 月營收 YoY&gt;0。
        「綜合 #」= 19 因子綜合排名(基本面+動能+籌碼),⭐ = 進場訊號 —{" "}
        <span className="text-zinc-400">基本面分對景氣循環股偏嚴,綜合排名才是系統完整判斷</span>。
        淨損益已扣手續費(0.0855%×2)+ 證交稅(現股 0.3%、ETF 0.1%)
      </p>
    </section>
  );
}
