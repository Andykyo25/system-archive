import { createClient } from "@/lib/supabase/server";
import { fmtMoney, fmtPct, pctColor } from "./_components/Format";
import { PriceCell } from "./_components/PriceCell";
import type { HoldingPnL, PortfolioSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const sb = createClient();
  const [{ data: summary }, { data: holdings }] = await Promise.all([
    sb.from("v_portfolio_summary").select("*").single(),
    sb
      .from("v_holdings_pnl")
      .select("*")
      .order("market_value", { ascending: false, nullsFirst: false }),
  ]);

  return (
    <div className="space-y-8">
      <SummaryCards summary={summary as PortfolioSummary | null} />
      <HoldingsSection rows={(holdings as HoldingPnL[] | null) ?? []} />
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
      <Stat label="總成本" value={fmtMoney(summary.total_cost)} />
      <Stat label="總市值" value={fmtMoney(summary.total_value)} />
      <Stat
        label="未實現損益"
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

function HoldingsSection({ rows }: { rows: HoldingPnL[] }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">真實持股</h2>
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
            <tr>
              <th className="px-3 py-2">股號</th>
              <th className="px-3 py-2 text-right">股數</th>
              <th className="px-3 py-2 text-right">均價</th>
              <th className="px-3 py-2 text-right">現價</th>
              <th className="px-3 py-2 text-right">市值</th>
              <th className="px-3 py-2 text-right">損益</th>
              <th className="px-3 py-2 text-right">%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.id} className="border-t border-zinc-800">
                <td className="px-3 py-2 font-mono">{h.symbol}</td>
                <td className="px-3 py-2 text-right tabular-nums">{h.qty}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtMoney(h.avg_cost, 2)}
                </td>
                <td className="px-3 py-2 text-right">
                  <PriceCell
                    value={h.current_price}
                    isProvisional={h.is_provisional}
                    date={h.price_date}
                  />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtMoney(h.market_value, 0)}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${pctColor(h.unrealized_pnl)}`}
                >
                  {fmtMoney(h.unrealized_pnl, 0)}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${pctColor(h.unrealized_pct)}`}
                >
                  {fmtPct(h.unrealized_pct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
