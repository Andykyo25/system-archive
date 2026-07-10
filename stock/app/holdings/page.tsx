import { createClient } from "@/lib/supabase/server";
import { unwrap } from "@/lib/db";
import { BuyForm } from "./BuyForm";
import { DayTradeDialog } from "./DayTradeDialog";
import { fmtMoney, fmtPct, pctColor } from "../_components/Format";
import { PriceCell } from "../_components/PriceCell";
import { SellDialog } from "./SellDialog";
import { DeleteTxnButton } from "./DeleteTxnButton";
import {
  HoldingsAdvice,
  type HoldingAdviceRow,
  type SignalRow,
} from "./HoldingsAdvice";
import { AlertDialog, type ActiveAlert } from "./AlertDialog";
import { cancelPriceAlert } from "./actions";

export const dynamic = "force-dynamic";

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
  created_at?: string;
  is_day_trade?: boolean;
}

interface TradeBehaviorRow {
  txn_id: string;
  symbol: string;
  sell_date: string;
  qty_sold: number;
  realized_pnl: number | string;
  realized_pct: number | string | null;
  is_win: boolean;
  holding_days: number | null;
  fwd_days_available: number;
  fwd_20d_pct: number | string | null;
  fwd_max20_pct: number | string | null;
  // v2 買入質量
  entry_date: string | null;
  entry_price: number | string | null;
  dev_ma20_at_buy: number | string | null;
  ret20d_at_buy: number | string | null;
  is_chase_buy: boolean | null;
  is_reentry_buy: boolean;
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
  dayTaxStock: number;
  dayTaxEtf: number;
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
      "day_trade_tax_stock",
      "day_trade_tax_etf",
    ]);
  const rows = (data ?? []) as { key: string; value: number | string }[];
  const map = new Map<string, number>(
    rows.map((r) => [r.key, Number(r.value)]),
  );
  return {
    feeRate: (map.get("commission_discount") ?? 1) * (map.get("commission_base_rate") ?? 0.001425),
    taxStock: map.get("sell_tax_stock") ?? 0.003,
    taxEtf: map.get("sell_tax_etf") ?? 0.001,
    dayTaxStock: map.get("day_trade_tax_stock") ?? 0.0015,
    dayTaxEtf: map.get("day_trade_tax_etf") ?? 0.0005,
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
    { data: dayTrades },
    { data: transactions },
    { data: advice },
    { data: signals },
    { data: behavior },
    { data: alertRules },
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
      .from("v_day_trades_realized")
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
    sb
      .from("v_trade_behavior")
      .select("*")
      .order("sell_date", { ascending: false }),
    sb
      .from("alert_rules")
      .select("id, symbol, condition, threshold, note, created_at")
      .eq("enabled", true)
      .order("created_at", { ascending: false }),
    loadFeeSettings(),
  ]);

  // 持股核心 query 失敗 → throw 到 app/error.tsx(不靜默空表,A3/L42)
  const holdings = unwrap(holdingsR, "v_holdings_pnl");

  const rows = (holdings as CurrentHolding[] | null) ?? [];
  const realizedRows = [
    ...((realized as RealizedRow[] | null) ?? []),
    ...((dayTrades as RealizedRow[] | null) ?? []),
  ].sort((a, b) => {
    if (a.sell_date !== b.sell_date) return a.sell_date < b.sell_date ? 1 : -1;
    return (a.created_at ?? "") < (b.created_at ?? "") ? 1 : -1;
  });
  const txnRows = (transactions as Transaction[] | null) ?? [];
  const sum = (summary as Summary | null) ?? null;
  const portfolioSum = (portfolio as PortfolioSummary | null) ?? null;
  const adviceRows = (advice as HoldingAdviceRow[] | null) ?? [];
  const signalsMap: Record<string, SignalRow> = {};
  for (const s of (signals as SignalRow[] | null) ?? []) {
    signalsMap[s.symbol] = s;
  }
  const behaviorRows = (behavior as TradeBehaviorRow[] | null) ?? [];

  // 到價提醒:active rules + 持股快捷價(停損/加碼,來自 v_holdings_advice)
  const alertRows = (alertRules as (ActiveAlert & { created_at: string })[] | null) ?? [];
  const alertsBySymbol: Record<string, ActiveAlert[]> = {};
  for (const a of alertRows) {
    (alertsBySymbol[a.symbol] ??= []).push(a);
  }
  const advicePrices: Record<string, { stop: number | null; add: number | null }> = {};
  for (const a of adviceRows) {
    const stop = Number(a.stop_loss_price);
    const add = Number(a.add_position_price);
    advicePrices[a.symbol] = {
      stop: Number.isFinite(stop) ? stop : null,
      add: Number.isFinite(add) ? add : null,
    };
  }

  return (
    <div className="space-y-8">
      <SummarySection summary={sum} portfolio={portfolioSum} />

      <AddBuySection fees={fees} />

      <CurrentHoldingsSection
        rows={rows}
        fees={fees}
        advicePrices={advicePrices}
        alertsBySymbol={alertsBySymbol}
      />

      <ActiveAlertsSection rows={alertRows} />

      <HoldingsAdvice rows={adviceRows} signalsMap={signalsMap} />

      <TradeBehaviorSection rows={behaviorRows} />

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

function AddBuySection({ fees }: { fees: FeeSettings }) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">新增買入</h2>
        <DayTradeDialog
          feeRate={fees.feeRate}
          taxStock={fees.dayTaxStock}
          taxEtf={fees.dayTaxEtf}
        />
      </div>
      <BuyForm />
      <p className="mt-2 text-xs text-zinc-500">
        手續費會自動依設定算入 fee 欄(雙邊都收)。BUY 不收證交稅。
        股號輸入後會自動顯示進場脈絡(追高 / 回追 / 盲區警示)。
      </p>
    </section>
  );
}

function CurrentHoldingsSection({
  rows,
  fees,
  advicePrices,
  alertsBySymbol,
}: {
  rows: CurrentHolding[];
  fees: FeeSettings;
  advicePrices: Record<string, { stop: number | null; add: number | null }>;
  alertsBySymbol: Record<string, ActiveAlert[]>;
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
                      <div className="flex justify-end gap-1.5">
                        <AlertDialog
                          symbol={h.symbol}
                          currentPrice={currentPrice}
                          stopLoss={advicePrices[h.symbol]?.stop ?? null}
                          addPosition={advicePrices[h.symbol]?.add ?? null}
                          alerts={alertsBySymbol[h.symbol] ?? []}
                        />
                        <SellDialog
                          symbol={h.symbol}
                          netQty={Number(h.qty)}
                          avgCost={Number(h.avg_cost)}
                          currentPrice={currentPrice}
                          feeRate={fees.feeRate}
                          taxRate={taxRate}
                        />
                      </div>
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

// 到價提醒總覽:含非持股遺留規則(如舊 /rank 掛的耐心價),UI 可取消 — 收 A3 半拆債
function ActiveAlertsSection({
  rows,
}: {
  rows: (ActiveAlert & { created_at: string })[];
}) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">
        到價提醒 ({rows.length})
        <span className="ml-2 text-xs font-normal text-zinc-500">
          盤中每 10 分檢查,觸價 TG 推播後自動停用
        </span>
      </h2>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900">
        {rows.map((a) => (
          <div
            key={a.id}
            className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 px-4 py-2 text-sm first:border-t-0"
          >
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="font-mono text-blue-400">{a.symbol}</span>
              <span className="tabular-nums text-zinc-200">
                {a.condition === "price_below" ? "跌到 ≤" : "漲到 ≥"}{" "}
                {Number(a.threshold).toLocaleString()}
              </span>
              {a.note && <span className="text-xs text-zinc-500">{a.note}</span>}
              <span className="text-xs text-zinc-600">
                {a.created_at.slice(0, 10)} 掛
              </span>
            </div>
            <form action={cancelPriceAlert}>
              <input type="hidden" name="id" value={a.id} />
              <button className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-300">
                取消
              </button>
            </form>
          </div>
        ))}
      </div>
    </section>
  );
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 賣出時機判定(以「續抱 20 交易日」結果為準):正 = 賣太早、負 = 出場時機佳。
function VerdictTag({
  fwd,
  daysAvail,
}: {
  fwd: number | null;
  daysAvail: number;
}) {
  if (fwd == null) {
    return (
      <span
        className="text-zinc-600"
        title={
          daysAvail === 0
            ? "已出清且不在追蹤池,賣後無收盤資料"
            : "賣後尚不足 20 交易日,待累積"
        }
      >
        —
      </span>
    );
  }
  if (fwd > 3) {
    return (
      <span
        className="rounded bg-amber-900/40 px-2 py-0.5 text-xs text-amber-200"
        title={`續抱 20 交易日會多賺 ${fwd.toFixed(1)}%`}
      >
        賣太早
      </span>
    );
  }
  if (fwd < -3) {
    return (
      <span
        className="rounded bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-200"
        title={`早出避開 ${Math.abs(fwd).toFixed(1)}% 回檔`}
      >
        時機佳
      </span>
    );
  }
  return (
    <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
      中性
    </span>
  );
}

// B1 交易行為分析:量化「賣太早 / 出場時機」(借鏡 Vibe-Trading Shadow Account)。
function TradeBehaviorSection({ rows }: { rows: TradeBehaviorRow[] }) {
  if (rows.length === 0) return null;
  const total = rows.length;
  const wins = rows.filter((r) => r.is_win).length;
  const holdDays = rows
    .map((r) => r.holding_days)
    .filter((d): d is number => d != null);
  const avgHold = holdDays.length
    ? holdDays.reduce((a, b) => a + b, 0) / holdDays.length
    : null;
  // 有賣後資料(續抱 20 交易日可評)的交易
  const withFwd = rows.filter((r) => num(r.fwd_20d_pct) != null);
  const soldEarly = withFwd.filter((r) => (num(r.fwd_20d_pct) ?? 0) > 3).length;
  const goodExit = withFwd.filter((r) => (num(r.fwd_20d_pct) ?? 0) < -3).length;
  const avgFwd20 = withFwd.length
    ? withFwd.reduce((a, r) => a + (num(r.fwd_20d_pct) ?? 0), 0) / withFwd.length
    : null;
  // v2 買入質量統計(追高 = 買進日 dev MA20 > +10%;回追 = 近10日賣過又更高價買回)
  const chaseW = rows.filter((r) => r.is_chase_buy === true && r.is_win).length;
  const chaseL = rows.filter((r) => r.is_chase_buy === true && !r.is_win).length;
  const reW = rows.filter((r) => r.is_reentry_buy && r.is_win).length;
  const reL = rows.filter((r) => r.is_reentry_buy && !r.is_win).length;

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">交易行為分析</h2>
        <span className="text-xs text-zinc-500">
          買點質量 + 賣出後若續抱的結果(不含當沖)
        </span>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card
          label="勝率"
          value={`${wins}/${total}`}
          sub={`追高買 ${chaseW}勝${chaseL}敗 · 回追 ${reW}勝${reL}敗`}
        />
        <Card
          label="平均持有"
          value={avgHold != null ? `${avgHold.toFixed(0)} 天` : "—"}
        />
        <Card
          label="續抱20日平均"
          value={avgFwd20 != null ? fmtPct(avgFwd20) : "—"}
          color={pctColor(avgFwd20)}
          sub={`${withFwd.length} 筆可評`}
        />
        <Card
          label="賣太早 / 時機佳"
          value={`${soldEarly} / ${goodExit}`}
          sub="續抱 ±3% 判定"
        />
      </div>
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
            <tr>
              <th className="px-3 py-2">賣出日</th>
              <th className="px-3 py-2">股號</th>
              <th className="px-3 py-2 text-right" title="你實際出場的報酬率">
                你的出場%
              </th>
              <th className="px-3 py-2 text-right">持有</th>
              <th
                className="px-3 py-2 text-right"
                title="開倉日收盤 vs MA20 偏離。>+10% = 追高區(紅字);🔁 = 近10日賣過又更高價買回"
              >
                買點 MA20±
              </th>
              <th
                className="px-3 py-2 text-right"
                title="賣出後第 20 交易日 vs 賣出價 = 若當時續抱的結果"
              >
                續抱20日
              </th>
              <th
                className="px-3 py-2 text-right"
                title="賣後 20 交易日內最高 vs 賣出價 = 完美時機可多賺多少"
              >
                期間最高
              </th>
              <th className="px-3 py-2 text-center">判定</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const fwd20 = num(r.fwd_20d_pct);
              const fwdMax = num(r.fwd_max20_pct);
              return (
                <tr key={r.txn_id} className="border-t border-zinc-800">
                  <td className="px-3 py-2 text-zinc-400">{r.sell_date}</td>
                  <td className="px-3 py-2 font-mono">{r.symbol}</td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${pctColor(r.realized_pct)}`}
                  >
                    {fmtPct(r.realized_pct)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                    {r.holding_days != null ? `${r.holding_days} 天` : "—"}
                  </td>
                  <BuyQualityCell
                    dev={num(r.dev_ma20_at_buy)}
                    isChase={r.is_chase_buy}
                    isReentry={r.is_reentry_buy}
                  />
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${pctColor(fwd20)}`}
                  >
                    {fwd20 != null ? fmtPct(fwd20) : "N/A"}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${pctColor(fwdMax)}`}
                  >
                    {fwdMax != null ? fmtPct(fwdMax) : "N/A"}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <VerdictTag fwd={fwd20} daysAvail={r.fwd_days_available} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        「買點 MA20±」= 開倉日收盤 vs MA20 偏離(&gt;+10% 紅字 = 追高區;🔁 =
        近 10 日賣過又更高價買回);「續抱20日」= 賣出後第 20 交易日 vs
        賣出價;「期間最高」= 賣後 20 交易日內最高(完美時機上限)。正 =
        賣太早、負 = 出場時機佳。N/A = 資料不足。持有天數以開倉日(淨部位歸零後首買)起算。樣本小,僅供自我檢視。
      </p>
    </section>
  );
}

// 買點質量 cell:dev MA20 偏離(追高紅字)+ 回追 🔁 badge
function BuyQualityCell({
  dev,
  isChase,
  isReentry,
}: {
  dev: number | null;
  isChase: boolean | null;
  isReentry: boolean;
}) {
  return (
    <td className="px-3 py-2 text-right tabular-nums">
      <span className={isChase ? "font-medium text-red-400" : "text-zinc-400"}>
        {dev != null ? `${dev >= 0 ? "+" : ""}${dev.toFixed(1)}%` : "—"}
      </span>
      {isReentry && (
        <span className="ml-1" title="賣飛回追:近 10 日賣過同檔,又用更高價買回">
          🔁
        </span>
      )}
    </td>
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
                  <td className="px-3 py-2 font-mono">
                    {r.symbol}
                    {r.is_day_trade && (
                      <span className="ml-1.5 rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-300">
                        當沖
                      </span>
                    )}
                  </td>
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
