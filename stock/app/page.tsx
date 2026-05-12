import { Fragment } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
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

export default async function Dashboard() {
  const sb = createClient();
  const [
    { data: summary },
    { data: holdings },
    { data: signals },
    { data: perfSummary },
    { data: realizedRows },
    { data: buyTxns },
    { data: ranks },
  ] = await Promise.all([
    sb.from("v_portfolio_summary").select("*").single(),
    sb
      .from("v_holdings_full")
      .select("*")
      .order("market_value", { ascending: false, nullsFirst: false }),
    sb
      .from("v_entry_signal")
      .select(
        "symbol, weighted_score, expected_rank, signal_strength, fund_count_pos, fund_count_total, mom_count_pos, mom_count_total, chip_count_pos, chip_count_total, is_entry_signal",
      )
      .eq("is_entry_signal", true)
      .order("weighted_score", { ascending: false, nullsFirst: false })
      .limit(10),
    // 「我的交易表現」widget 用
    sb
      .from("v_holdings_summary")
      .select("total_realized_pnl, total_invested, count_closed")
      .single(),
    sb
      .from("v_holdings_realized")
      .select("symbol, sell_date, realized_pnl, realized_pct, qty_sold")
      .order("sell_date", { ascending: false })
      .order("created_at", { ascending: false }),
    sb
      .from("holdings_transactions")
      .select("symbol, txn_date")
      .eq("txn_type", "BUY")
      .order("txn_date", { ascending: true }),
    // 「給 Andy 的建議」widget 用 — top 30 取夠用,後續再 filter
    sb
      .from("v_stock_rank")
      .select(
        "symbol, weighted_score, fund_count_pos, fund_count_total, expected_rank",
      )
      .gte("fund_count_pos", 5)
      .order("expected_rank", { ascending: true })
      .limit(30),
  ]);

  // entry signal name lookup(原邏輯)+ rank picks name lookup(新邏輯)合併一次取
  const signalRows = (signals as EntrySignalSummary[] | null) ?? [];
  const rankRowsRaw =
    (ranks as
      | {
          symbol: string;
          weighted_score: number | string | null;
          fund_count_pos: number;
          fund_count_total: number;
        }[]
      | null) ?? [];

  const allLookupSymbols = Array.from(
    new Set([...signalRows.map((s) => s.symbol), ...rankRowsRaw.map((r) => r.symbol)]),
  );

  const nameMap: Record<string, string | null> = {};
  const industryMap: Record<string, string | null> = {};
  if (allLookupSymbols.length > 0) {
    const [is, su, em] = await Promise.all([
      sb
        .from("industry_stocks")
        .select("symbol, name, industry")
        .in("symbol", allLookupSymbols),
      sb
        .from("stock_universe")
        .select("symbol, name")
        .in("symbol", allLookupSymbols),
      sb.from("etf_metadata").select("symbol, name").in("symbol", allLookupSymbols),
    ]);
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
          }[]
        | null) ?? []
    ).map((r) => ({
      ...r,
      first_buy_date: firstBuyMap.get(r.symbol) ?? null,
    }));

  // 持有中的 symbol → 排除掉(可關注標的不該推「已經持有的」)
  const heldSymbols = new Set(
    ((holdings as HoldingFull[] | null) ?? []).map((h) => h.symbol),
  );
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

  return (
    <div className="space-y-6">
      <SummaryCards summary={summary as PortfolioSummary | null} />
      <PerformanceWidget
        summary={perfSummary as PerfSummary | null}
        realized={perfRealized}
      />
      <AdviceWidget picks={advicePicks} />
      <EntrySignalWidget rows={signalRows} nameMap={nameMap} />
      <HoldingsAnalysis rows={(holdings as HoldingFull[] | null) ?? []} />
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

function HoldingsAnalysis({ rows }: { rows: HoldingFull[] }) {
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
              <th className="px-3 py-2 text-center" title="hover 看完整中文分析">分</th>
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
                    <span className={`cursor-help rounded px-2 py-0.5 text-xs font-semibold tabular-nums ${scoreClass(h.score)}`}>
                      {h.score}/6
                    </span>
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
        評分 0-6:EPS 連 4 季正 / ROE&gt;15% / FCF&gt;0 / PEG&lt;1 / PB&lt;產業門檻 / 月營收 YoY&gt;0 ·
        淨損益已扣手續費(0.0855%×2)+ 證交稅(現股 0.3%、ETF 0.1%)
      </p>
    </section>
  );
}
