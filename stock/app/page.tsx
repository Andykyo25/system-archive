import { Fragment } from "react";
import { createClient } from "@/lib/supabase/server";
import { fmtMoney, fmtPct, pctColor } from "./_components/Format";
import { PriceCell } from "./_components/PriceCell";
import { analyzeRow } from "./_components/Analyze";

export const dynamic = "force-dynamic";

interface PortfolioSummary {
  positions: number;
  total_cost: number | string;
  total_value: number | string;
  total_pnl: number | string;
  total_pct: number | string;
}

interface HoldingFull {
  id: number;
  symbol: string;
  qty: number;
  avg_cost: number | string;
  current_price: number | string | null;
  price_date: string | null;
  is_provisional: boolean | null;
  unrealized_pnl: number | string | null;
  unrealized_pct: number | string | null;
  market_value: number | string | null;
  cost_basis: number | string;
  stock_type: "stock" | "etf";
  commission_rate: number | string;
  sell_tax_rate: number | string;
  total_cost_with_fee: number | string;
  net_proceeds_if_sold_now: number | string | null;
  net_pnl_est: number | string | null;
  net_pct_est: number | string | null;
  primary_industry: string | null;
  eps_ttm: number | string | null;
  eps_yoy_pct: number | string | null;
  last_q_eps_yoy_pct: number | string | null;
  forecast_eps_yoy_pct: number | string | null;
  roe_ttm: number | string | null;
  fcf_ttm: number | string | null;
  gross_margin_pct: number | string | null;
  gross_margin_yoy_pp: number | string | null;
  pe: number | string | null;
  pb: number | string | null;
  peg: number | string | null;
  peg_basis: string | null;
  pb_threshold: number | string | null;
  score: number;
}

function scoreClass(score: number): string {
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

export default async function Dashboard() {
  const sb = createClient();
  const [{ data: summary }, { data: holdings }] = await Promise.all([
    sb.from("v_portfolio_summary").select("*").single(),
    sb
      .from("v_holdings_full")
      .select("*")
      .order("market_value", { ascending: false, nullsFirst: false }),
  ]);

  return (
    <div className="space-y-8">
      <SummaryCards summary={summary as PortfolioSummary | null} />
      <HoldingsAnalysis rows={(holdings as HoldingFull[] | null) ?? []} />
    </div>
  );
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
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="持股檔數" value={String(summary.positions)} />
      <Stat label="總成本(毛)" value={fmtMoney(summary.total_cost)} />
      <Stat label="總市值" value={fmtMoney(summary.total_value)} />
      <Stat
        label="未實現損益(毛)"
        value={fmtMoney(summary.total_pnl)}
        sub={fmtPct(summary.total_pct)}
        color={pctColor(summary.total_pnl)}
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
        <div className={`text-sm tabular-nums ${color}`}>{sub}</div>
      ) : null}
    </div>
  );
}

function HoldingsAnalysis({ rows }: { rows: HoldingFull[] }) {
  if (rows.length === 0) return null;
  const COL_COUNT = 13;
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">真實持股(含基本面分析 + 稅後估算)</h2>
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
            <tr>
              <th className="px-3 py-2">股號</th>
              <th className="px-3 py-2 text-center">分</th>
              <th className="px-3 py-2 text-right">股數</th>
              <th className="px-3 py-2 text-right">均價</th>
              <th className="px-3 py-2 text-right">現價</th>
              <th className="px-3 py-2 text-right" title="毛市值,未扣手續費/稅">市值</th>
              <th className="px-3 py-2 text-right" title="稅後預估淨損益:賣出實得 − 含費成本">淨損益(估)</th>
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
              const grossPnl = Number(h.unrealized_pnl);
              const netPnl = Number(h.net_pnl_est);
              const feeDiff = Number.isFinite(grossPnl) && Number.isFinite(netPnl)
                ? grossPnl - netPnl : null;
              const netPnlTip = feeDiff != null
                ? `毛 ${fmtMoney(grossPnl, 0)} / 手續費+稅 ${fmtMoney(feeDiff, 0)}`
                : "";
              return (
                <Fragment key={h.id}>
                  <tr className="border-t border-zinc-800">
                    <td className="px-3 py-2 font-mono">
                      {h.symbol}
                      {h.stock_type === "etf" && (
                        <span className="ml-1 rounded bg-blue-900 px-1 text-[10px] text-blue-200">ETF</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`rounded px-2 py-0.5 text-xs font-semibold tabular-nums ${scoreClass(h.score)}`}>
                        {h.score}/5
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{h.qty}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(h.avg_cost, 2)}</td>
                    <td className="px-3 py-2 text-right">
                      <PriceCell value={h.current_price} isProvisional={h.is_provisional} date={h.price_date} />
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
                  <tr className="border-t border-zinc-900/50 bg-zinc-950/40">
                    <td colSpan={COL_COUNT} className="px-3 py-2 text-xs leading-relaxed text-zinc-400">
                      <span className="font-semibold text-zinc-200">{analysis.headline}</span>
                      {analysis.notes.length > 0 && (
                        <>
                          <br />
                          <span className="text-zinc-400">{analysis.notes.join("　·　")}</span>
                        </>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        評分 0-5:EPS 連 4 季正 / ROE&gt;15% / FCF&gt;0 / PEG&lt;1 / PB&lt;產業門檻 ·
        淨損益已扣 0.0855% × 2 手續費 + 0.3% 證交稅(ETF 0.1%)
      </p>
    </section>
  );
}
