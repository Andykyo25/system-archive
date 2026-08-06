import { TableShell, THead } from "@/app/_components/ui";
import { createClient } from "@/lib/supabase/server";
import { unwrap } from "@/lib/db";
import { fmtMoney } from "../_components/Format";
import {
  EquityLadderChart,
  type EquityPoint,
} from "../_components/EquityLadderChart";

export const dynamic = "force-dynamic";

interface SummaryRow {
  total_realized_pnl: number | string;
  count_closed: number | string;
  count_holdings: number | string;
}

export default async function PerformancePage() {
  const sb = createClient();

  const [pRes, sRes, cRes] = await Promise.all([
    sb
      .from("v_equity_curve")
      .select("*")
      .order("event_date", { ascending: true })
      .order("created_at", { ascending: true }),
    sb.from("v_holdings_summary").select("*").single(),
    sb.from("app_settings").select("value").eq("key", "initial_capital"),
  ]);

  const points = unwrap(pRes, "equity-curve") as EquityPoint[];
  const summary = unwrap(sRes, "holdings-summary") as SummaryRow;
  const capRows = unwrap(cRes, "initial-capital") as {
    value: number | string;
  }[];

  // initial_capital 以「萬」存(沿用 budget_ntd 繞 numeric(10,6)),×10000 還原為元
  const initialCapital = Number(capRows[0]?.value ?? 0) * 10000;
  const finalEquity =
    points.length > 0
      ? Number(points[points.length - 1].equity)
      : initialCapital;
  const totalRet =
    initialCapital > 0 ? (finalEquity / initialCapital - 1) * 100 : 0;
  const realized = Number(summary?.total_realized_pnl ?? 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">績效 · 權益曲線</h1>
        <p className="mt-1 text-xs text-zinc-500">
          階梯式·每筆落袋:本金為起點,每次平倉跳升該筆已實現損益(扣費稅)。
          持股期間僅微降買入手續費,不含未實現浮動。
        </p>
      </div>

      {/* Summary 卡 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-2xl border border-line bg-surface-1 p-4">
          <div className="text-xs text-zinc-500">初始本金</div>
          <div className="mt-1 text-lg font-semibold text-zinc-200 tabular-nums">
            {fmtMoney(initialCapital)}
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-surface-1 p-4">
          <div className="text-xs text-zinc-500">目前權益</div>
          <div className="mt-1 text-lg font-semibold text-amber-400 tabular-nums">
            {fmtMoney(finalEquity)}
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-surface-1 p-4">
          <div className="text-xs text-zinc-500">總報酬</div>
          <div className="mt-1 text-lg font-semibold text-rose-400 tabular-nums">
            {totalRet >= 0 ? "+" : ""}
            {totalRet.toFixed(1)}%
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-surface-1 p-4">
          <div className="text-xs text-zinc-500">
            累計已實現 · 平倉 {Number(summary?.count_closed ?? 0)} 檔
          </div>
          <div className="mt-1 text-lg font-semibold text-rose-400 tabular-nums">
            {realized >= 0 ? "+" : ""}
            {fmtMoney(realized)}
          </div>
        </div>
      </div>

      {/* 階梯權益曲線 */}
      <EquityLadderChart points={points} initialCapital={initialCapital} />

      {/* 交易事件明細 */}
      <div>
        <h2 className="mb-2 text-sm font-semibold text-zinc-300">
          交易事件明細
        </h2>
        <TableShell>
          <table className="w-full text-sm">
            <THead>
              <tr>
                <th className="px-3 py-2">日期</th>
                <th className="px-3 py-2">標的</th>
                <th className="px-3 py-2">動作</th>
                <th className="px-3 py-2 text-right">股數</th>
                <th className="px-3 py-2 text-right">價格</th>
                <th className="px-3 py-2 text-right">本筆增減</th>
                <th className="px-3 py-2 text-right">帳戶權益</th>
              </tr>
            </THead>
            <tbody>
              {points.map((p, idx) => {
                const isBuy = p.event_type === "BUY";
                const isDayTrade = p.event_type === "DAY_TRADE";
                const delta = Number(p.delta ?? 0);
                return (
                  <tr
                    key={idx}
                    className="border-t border-line-soft/60 text-zinc-300"
                  >
                    <td className="px-3 py-2 tabular-nums text-zinc-400">
                      {p.event_date}
                    </td>
                    <td className="px-3 py-2 font-mono">{p.symbol}</td>
                    <td className="px-3 py-2">
                      {isBuy ? (
                        <span className="text-sky-400">買進</span>
                      ) : isDayTrade ? (
                        <span className="text-amber-400">當沖</span>
                      ) : (
                        <span className="text-rose-400">賣出</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {Number(p.qty).toLocaleString("zh-TW")}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(p.price, 2)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        isBuy
                          ? "text-zinc-500"
                          : delta < 0
                            ? "text-green-400"
                            : "text-rose-400"
                      }`}
                    >
                      {!isBuy && delta > 0 ? "+" : ""}
                      {fmtMoney(delta)}
                      {isBuy && (
                        <span className="ml-1 text-[10px] text-zinc-600">
                          手續費
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums text-zinc-200">
                      {fmtMoney(p.equity)}
                    </td>
                  </tr>
                );
              })}
              {points.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-6 text-center text-zinc-500"
                  >
                    尚無交易紀錄
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableShell>
      </div>

      <p className="text-xs text-zinc-600">
        ⚠ 假設單一初始本金、期間無額外存提。本金可於「設定」調整。
      </p>
    </div>
  );
}
