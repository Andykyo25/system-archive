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

// v_account_equity_daily(2026-08-17):每日 MTM。階梯曲線持股期間是平的,回撤看不出來;
// 這條才是風險曲線。coverage_ok=false 的日子無法 MTM,不參與回撤統計。
// 2026-08-28:Andy 確認 08 月現金轉負是**加碼入金**不是融資 → initial_capital 這個單一常數
// 就是錯的分母。新增 capital_flows 表 + TWR(時間加權)欄位:
//   drawdown_pct      舊的權益基準回撤,有外部金流時會失真,只留當稽核錨點
//   twr_drawdown_pct  正確的回撤(入金當天中性化,不會被誤記成創新高)
//   capital_incomplete 現金為負 = 有入金還沒登錄,該列報酬率不可引用
interface DailyEquityRow {
  trade_date: string;
  equity: number | string;
  peak_equity: number | string;
  drawdown_pct: number | string | null;
  coverage_ok: boolean;
  cash: number | string;
  contributed_capital: number | string;
  twr_return_pct: number | string | null;
  twr_drawdown_pct: number | string | null;
  capital_incomplete: boolean;
}

export default async function PerformancePage() {
  const sb = createClient();

  const [pRes, sRes, cRes, dRes] = await Promise.all([
    sb
      .from("v_equity_curve")
      .select("*")
      .order("event_date", { ascending: true })
      .order("created_at", { ascending: true }),
    sb.from("v_holdings_summary").select("*").single(),
    sb.from("app_settings").select("value").eq("key", "initial_capital"),
    sb
      .from("v_account_equity_daily")
      .select(
        "trade_date, equity, peak_equity, drawdown_pct, coverage_ok, cash, contributed_capital, twr_return_pct, twr_drawdown_pct, capital_incomplete",
      )
      .order("trade_date", { ascending: true }),
  ]);

  const points = unwrap(pRes, "equity-curve") as EquityPoint[];
  const summary = unwrap(sRes, "holdings-summary") as SummaryRow;
  const capRows = unwrap(cRes, "initial-capital") as {
    value: number | string;
  }[];
  const daily = unwrap(dRes, "account-equity-daily") as DailyEquityRow[];

  // 真回撤只在 coverage_ok 的日子有意義(009816 持有期間 price_daily 零筆 → 無法 MTM)
  // 2026-08-28 起改用 twr_drawdown_pct:外部金流當天中性化,入金不會被記成「創新高」
  const covered = daily.filter((d) => d.coverage_ok && d.twr_drawdown_pct != null);
  const maxDd = covered.reduce<DailyEquityRow | null>(
    (worst, d) =>
      worst == null ||
      Number(d.twr_drawdown_pct) < Number(worst.twr_drawdown_pct)
        ? d
        : worst,
    null,
  );
  // 現金為負 = 有入金沒登錄到 capital_flows → 分母錯,所有報酬率都不可引用
  const incompleteDays = daily.filter((d) => d.capital_incomplete);
  const capitalIncomplete = incompleteDays.length > 0;
  const contributed =
    daily.length > 0 ? Number(daily[daily.length - 1].contributed_capital) : null;
  const twrRet =
    covered.length > 0
      ? Number(covered[covered.length - 1].twr_return_pct)
      : null;
  const lastDaily = covered.length > 0 ? covered[covered.length - 1] : null;
  const peakEquity = lastDaily != null ? Number(lastDaily.peak_equity) : null;

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
          下方曲線是<b>階梯式</b>(每次平倉跳升已實現損益,持股期間不含未實現浮動)=
          落袋節奏。「最大回撤 / 峰值」則來自 <code>v_account_equity_daily</code> 的
          <b>每日 mark-to-market</b> = 風險曲線。兩者刻意分開:階梯曲線只會在實現虧損時下降,
          用它算回撤會嚴重低估。
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          報酬率以 <b>TWR(時間加權)</b> 計:每次入金／出金在當天中性化,衡量的是
          <b>操作本身</b>的績效,不會因為多匯錢進來就變好看。
          {contributed != null && (
            <>
              {" "}目前累計投入本金 <b className="text-zinc-400">{fmtMoney(contributed)}</b>
              {twrRet != null && (
                <>,TWR 報酬 <b className="text-zinc-400">{twrRet >= 0 ? "+" : ""}{twrRet.toFixed(2)}%</b></>
              )}。
            </>
          )}
        </p>
      </div>

      {capitalIncomplete && (
        <div className="rounded-2xl border border-amber-800/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-medium text-amber-300">
            ⚠ 有 {incompleteDays.length} 個交易日的現金為負 —— 分母不完整,本頁報酬率不可引用
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-200/70">
            最早出現在 <b>{incompleteDays[0].trade_date}</b>
            (現金 {fmtMoney(Number(incompleteDays[0].cash))})。
            現金算式是「累計投入本金 + 交易現金流 + 當沖損益」,會變負數只有一種原因:
            <b>有加碼入金還沒登錄</b>。到 <code>/settings</code> 的「資金流水」把每筆入金
            (日期 + 金額)補上,峰值、回撤、TWR 才會是對的。
            <span className="text-amber-200/50">
              {" "}在補齊之前,系統寧可標記「不知道」也不顯示一個看起來合理的錯數字。
            </span>
          </p>
        </div>
      )}

      {/* Summary 卡 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
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
        <div className="rounded-2xl border border-line bg-surface-1 p-4">
          <div className="text-xs text-zinc-500">最大回撤(TWR)</div>
          <div className="mt-1 text-lg font-semibold text-green-400 tabular-nums">
            {maxDd != null ? `${Number(maxDd.twr_drawdown_pct).toFixed(1)}%` : "—"}
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-600">
            {maxDd != null ? `最深於 ${maxDd.trade_date}` : "資料不足"}
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-surface-1 p-4">
          <div className="text-xs text-zinc-500">權益峰值 · 目前距峰值</div>
          <div className="mt-1 text-lg font-semibold text-zinc-200 tabular-nums">
            {peakEquity != null ? fmtMoney(peakEquity) : "—"}
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-600">
            {lastDaily != null
              ? `${lastDaily.trade_date} 收盤 ${Number(lastDaily.drawdown_pct).toFixed(1)}%`
              : "資料不足"}
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
        {covered.length < daily.length && (
          <>
            {" "}
            回撤統計排除 {daily.length - covered.length} 個無法 MTM 的交易日
            (該日持股在 <code>price_daily</code> 無報價 — 不用成本價假裝)。
          </>
        )}
      </p>
    </div>
  );
}
