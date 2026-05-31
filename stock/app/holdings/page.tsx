import { createClient } from "@/lib/supabase/server";
import { unwrap } from "@/lib/db";
import { addBuyTransaction } from "./actions";
import { fmtMoney, fmtPct, pctColor } from "../_components/Format";
import { PriceCell } from "../_components/PriceCell";
import { SellDialog } from "./SellDialog";
import { DeleteTxnButton } from "./DeleteTxnButton";
import {
  HoldingsAdvice,
  type HoldingAdviceRow,
  type SignalRow,
} from "./HoldingsAdvice";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none";
const btnCls =
  "rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700";

interface CurrentHolding {
  symbol: string;
  qty: number | string;
  avg_cost: number | string;
  current_price: number | string | null;
  price_date: string | null;
  is_provisional: boolean | null;
  // M8.3 多吐的 realtime metadata(目前 UI 不 surface,僅預留)
  as_of_ts: string | null;
  price_source: string | null;
  market_state: string | null;
  unrealized_pnl: number | string | null;
  unrealized_pct: number | string | null;
  market_value: number | string | null;
  cost_basis: number | string;
}

interface RealizedRow {
  txn_id: string;
  symbol: string;
  sell_date: string;
  qty_sold: number;
  sell_price: number | string;
  avg_cost_at_sell: number | string;
  realized_pnl: number | string;
  realized_pct: number | string | null;
  fee: number | string;
  tax: number | string;
  note: string | null;
}

interface Transaction {
  id: string;
  symbol: string;
  txn_type: "BUY" | "SELL";
  qty: number;
  price: number | string;
  fee: number | string;
  tax: number | string;
  txn_date: string;
  note: string | null;
  created_at: string;
}

interface Summary {
  total_realized_pnl: number | string;
  total_unrealized_pnl: number | string;
  total_pnl: number | string;
  total_invested: number | string;
  total_recovered: number | string;
  count_holdings: number | string;
  count_closed: number | string;
}

// v_portfolio_summary 提供「淨」未實現損益(扣雙邊手續費 + 證交稅),
// /holdings 的「未實現淨損益」Card 用此對齊 dashboard /(同樣讀 v_portfolio_summary.net_total_pnl)。
interface PortfolioSummary {
  total_pnl: number | string;       // gross 未實現(= summary.total_unrealized_pnl)
  net_total_pnl: number | string;   // 扣手續費後的淨未實現
  net_total_pct: number | string;
}

interface FeeSettings {
  feeRate: number;
  taxStock: number;
  taxEtf: number;
}

async function loadFeeSettings(): Promise<FeeSettings> {
  const sb = createClient();
  const { data } = await sb
    .from("app_settings")
    .select("key, value")
    .in("key", [
      "commission_discount",
      "commission_base_rate",
      "sell_tax_stock",
      "sell_tax_etf",
    ]);
  const rows = (data ?? []) as { key: string; value: number | string }[];
  const map = new Map<string, number>(
    rows.map((r) => [r.key, Number(r.value)]),
  );
  return {
    feeRate: (map.get("commission_discount") ?? 1) * (map.get("commission_base_rate") ?? 0.001425),
    taxStock: map.get("sell_tax_stock") ?? 0.003,
    taxEtf: map.get("sell_tax_etf") ?? 0.001,
  };
}

function isEtfSymbol(symbol: string): boolean {
  return /^00\d+/.test(symbol);
}

export default async function HoldingsPage() {
  const sb = createClient();
  const [
    { data: summary },
    { data: portfolio },
    holdingsR,
    { data: realized },
    { data: transactions },
    { data: advice },
    { data: signals },
    fees,
  ] = await Promise.all([
    sb.from("v_holdings_summary").select("*").single(),
    sb
      .from("v_portfolio_summary")
      .select("total_pnl, net_total_pnl, net_total_pct")
      .single(),
    sb
      .from("v_holdings_pnl")
      .select("*")
      .order("market_value", { ascending: false, nullsFirst: false }),
    sb
      .from("v_holdings_realized")
      .select("*")
      .order("sell_date", { ascending: false })
      .order("created_at", { ascending: false }),
    sb
      .from("holdings_transactions")
      .select("*")
      .order("txn_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200),
    sb
      .from("v_holdings_advice")
      .select("*"),
    sb
      .from("v_holdings_signals")
      .select(
        "symbol, signal_level, today_chg_pct, bench_chg_pct, tail_days_5, down_days_5, signals",
      ),
    loadFeeSettings(),
  ]);

  // 持股核心 query 失敗 → throw 到 app/error.tsx(不靜默空表,A3/L42)
  const holdings = unwrap(holdingsR, "v_holdings_pnl");

  const rows = (holdings as CurrentHolding[] | null) ?? [];
  const realizedRows = (realized as RealizedRow[] | null) ?? [];
  const txnRows = (transactions as Transaction[] | null) ?? [];
  const sum = (summary as Summary | null) ?? null;
  const portfolioSum = (portfolio as PortfolioSummary | null) ?? null;
  const adviceRows = (advice as HoldingAdviceRow[] | null) ?? [];
  const signalsMap: Record<string, SignalRow> = {};
  for (const s of (signals as SignalRow[] | null) ?? []) {
    signalsMap[s.symbol] = s;
  }

  return (
    <div className="space-y-8">
      <SummarySection summary={sum} portfolio={portfolioSum} />

      <AddBuySection />

      <CurrentHoldingsSection rows={rows} fees={fees} />

      <HoldingsAdvice rows={adviceRows} signalsMap={signalsMap} />

      <RealizedSection rows={realizedRows} />

      <TransactionLogSection rows={txnRows} />
    </div>
  );
}

function SummarySection({
  summary,
  portfolio,
}: {
  summary: Summary | null;
  portfolio: PortfolioSummary | null;
}) {
  const realized = Number(summary?.total_realized_pnl ?? 0);
  // 未實現損益:對齊 dashboard 主數字用「淨」(扣手續費 + 證交稅),sub 附「毛」對照。
  // 來源:v_portfolio_summary.net_total_pnl(同 dashboard);fallback 用 v_holdings_summary gross 避免 view 缺資料時整段空。
  const grossUnrealized = Number(
    portfolio?.total_pnl ?? summary?.total_unrealized_pnl ?? 0,
  );
  const netUnrealized = Number(portfolio?.net_total_pnl ?? grossUnrealized);
  const netUnrealizedPct = portfolio?.net_total_pct ?? null;
  const total = Number(summary?.total_pnl ?? 0);
  const invested = Number(summary?.total_invested ?? 0);
  const recovered = Number(summary?.total_recovered ?? 0);
  const countHoldings = Number(summary?.count_holdings ?? 0);
  const countClosed = Number(summary?.count_closed ?? 0);

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">總計</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card
          label="已實現損益"
          value={fmtMoney(realized, 0)}
          color={pctColor(realized || null)}
          sub={
            countClosed > 0 ? `${countClosed} 檔已平倉` : "尚無賣出紀錄"
          }
        />
        <Card
          label="未實現淨損益"
          value={fmtMoney(netUnrealized, 0)}
          color={pctColor(netUnrealized || null)}
          sub={
            countHoldings > 0
              ? `${
                  netUnrealizedPct != null ? fmtPct(netUnrealizedPct) : "—"
                }　·　毛 ${fmtMoney(grossUnrealized, 0)}　·　${countHoldings} 檔`
              : "目前無持股"
          }
        />
        <Card
          label="累計總損益"
          value={fmtMoney(total, 0)}
          color={pctColor(total || null)}
          sub={`投入 ${fmtMoney(invested, 0)} · 已回收 ${fmtMoney(recovered, 0)}`}
        />
      </div>
    </section>
  );
}

function Card({
  label,
  value,
  color = "",
  sub,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

function AddBuySection() {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">新增買入</h2>
      <form
        action={addBuyTransaction}
        className="grid grid-cols-1 gap-3 md:grid-cols-6"
      >
        <input
          name="symbol"
          placeholder="股號 (e.g. 2330)"
          required
          className={inputCls}
        />
        <input
          name="qty"
          type="number"
          min="1"
          placeholder="股數"
          required
          className={inputCls}
        />
        <input
          name="price"
          type="number"
          step="0.01"
          placeholder="買入價"
          required
          className={inputCls}
        />
        <input
          name="txn_date"
          type="date"
          defaultValue={new Date().toISOString().slice(0, 10)}
          required
          className={inputCls}
        />
        <input
          name="note"
          placeholder="備註 (選填)"
          className={inputCls}
        />
        <button className={btnCls}>新增</button>
      </form>
      <p className="mt-2 text-xs text-zinc-500">
        手續費會自動依設定算入 fee 欄(雙邊都收)。BUY 不收證交稅。
      </p>
    </section>
  );
}

function CurrentHoldingsSection({
  rows,
  fees,
}: {
  rows: CurrentHolding[];
  fees: FeeSettings;
}) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">持有中 ({rows.length})</h2>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
          沒有持股
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
              <tr>
                <th className="px-3 py-2">股號</th>
                <th className="px-3 py-2 text-right">股數</th>
                <th className="px-3 py-2 text-right">均價</th>
                <th className="px-3 py-2 text-right">現價</th>
                <th className="px-3 py-2 text-right">市值</th>
                <th className="px-3 py-2 text-right">未實現損益</th>
                <th className="px-3 py-2 text-right">%</th>
                <th className="px-3 py-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => {
                const taxRate = isEtfSymbol(h.symbol)
                  ? fees.taxEtf
                  : fees.taxStock;
                const currentPrice =
                  h.current_price == null ? null : Number(h.current_price);
                return (
                  <tr key={h.symbol} className="border-t border-zinc-800">
                    <td className="px-3 py-2 font-mono">
                      {h.symbol}
                      {isEtfSymbol(h.symbol) && (
                        <span className="ml-1 rounded bg-blue-900 px-1 text-[10px] text-blue-200">
                          ETF
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {h.qty}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(h.avg_cost, 2)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PriceCell
                        value={h.current_price}
                        isProvisional={h.is_provisional}
                        date={h.price_date}
                        asOfTs={h.as_of_ts}
                        source={h.price_source}
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
                    <td className="px-3 py-2 text-right">
                      <SellDialog
                        symbol={h.symbol}
                        netQty={Number(h.qty)}
                        avgCost={Number(h.avg_cost)}
                        currentPrice={currentPrice}
                        feeRate={fees.feeRate}
                        taxRate={taxRate}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-zinc-500">
        現價來自 v_latest_price_realtime(yahoo &lt; 30min &gt; 今日收盤 &gt;
        最近收盤)。hover 現價可看資料日期 / 來源。
      </p>
    </section>
  );
}

function RealizedSection({ rows }: { rows: RealizedRow[] }) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">
        已實現損益歷史 ({rows.length})
      </h2>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-500">
          還沒有賣出紀錄
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
              <tr>
                <th className="px-3 py-2">賣出日</th>
                <th className="px-3 py-2">股號</th>
                <th className="px-3 py-2 text-right">股數</th>
                <th className="px-3 py-2 text-right">賣出價</th>
                <th className="px-3 py-2 text-right">當下均價</th>
                <th className="px-3 py-2 text-right">手續費</th>
                <th className="px-3 py-2 text-right">證交稅</th>
                <th className="px-3 py-2 text-right">實現損益</th>
                <th className="px-3 py-2 text-right">%</th>
                <th className="px-3 py-2">備註</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.txn_id} className="border-t border-zinc-800">
                  <td className="px-3 py-2 text-zinc-400">{r.sell_date}</td>
                  <td className="px-3 py-2 font-mono">{r.symbol}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.qty_sold}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtMoney(r.sell_price, 2)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                    {fmtMoney(r.avg_cost_at_sell, 2)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                    {fmtMoney(r.fee, 2)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                    {fmtMoney(r.tax, 2)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${pctColor(r.realized_pnl)}`}
                  >
                    {fmtMoney(r.realized_pnl, 0)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${pctColor(r.realized_pct)}`}
                  >
                    {fmtPct(r.realized_pct)}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">
                    {r.note ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TransactionLogSection({ rows }: { rows: Transaction[] }) {
  return (
    <section>
      <details open className="rounded-lg border border-zinc-800 bg-zinc-900">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-zinc-200">
          全部交易紀錄 ({rows.length})
          <span className="ml-2 text-xs font-normal text-zinc-500">
            — 輸入錯了可在這裡刪除
          </span>
        </summary>
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-zinc-500">無紀錄</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-y border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
                <tr>
                  <th className="px-3 py-2">日期</th>
                  <th className="px-3 py-2">類型</th>
                  <th className="px-3 py-2">股號</th>
                  <th className="px-3 py-2 text-right">股數</th>
                  <th className="px-3 py-2 text-right">價格</th>
                  <th className="px-3 py-2 text-right">手續費</th>
                  <th className="px-3 py-2 text-right">證交稅</th>
                  <th className="px-3 py-2">備註</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="border-t border-zinc-800">
                    <td className="px-3 py-2 text-zinc-400">{t.txn_date}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${
                          t.txn_type === "BUY"
                            ? "bg-red-900/40 text-red-200"
                            : "bg-green-900/40 text-green-200"
                        }`}
                      >
                        {t.txn_type === "BUY" ? "買" : "賣"}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono">{t.symbol}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {t.qty}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMoney(t.price, 2)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                      {fmtMoney(t.fee, 2)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                      {fmtMoney(t.tax, 2)}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-400">
                      {t.note ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <DeleteTxnButton
                        id={t.id}
                        label={`${t.symbol} ${t.txn_type === "BUY" ? "買入" : "賣出"} ${t.qty} 股 @ ${fmtMoney(t.price, 2)}(${t.txn_date})`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-zinc-800 px-4 py-2 text-xs text-zinc-500">
          顯示最近 200 筆。刪除單筆會影響後續 SELL 的成本計算,謹慎使用。
        </p>
      </details>
    </section>
  );
}
