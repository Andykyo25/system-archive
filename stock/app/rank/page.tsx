import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fmtMoney, fmtPct, pctColor } from "@/app/_components/Format";

export const dynamic = "force-dynamic";

interface RankWithCostRow {
  symbol: string;
  weighted_score: number | string | null;
  expected_rank: number;
  fund_count_pos: number;
  fund_count_total: number;
  mom_count_pos: number;
  mom_count_total: number;
  rev_count_pos: number;
  rev_count_total: number;
  chip_count_pos: number;
  chip_count_total: number;
  fund_score_pct: number | string | null;
  mom_score_pct: number | string | null;
  rev_score_pct: number | string | null;
  chip_score_pct: number | string | null;
  latest_close: number | string | null;
  latest_date: string | null;
  ret_20d_pct: number | string | null;
  rsi14: number | string | null;
  off_high_60d_pct: number | string | null;
  // M9.3 新增(v_rank_with_cost join 出來的)
  current_price: number | string | null;
  cost_per_lot_ntd: number | string | null;
  price_source: string | null;
}

interface SignalRow {
  symbol: string;
  is_entry_signal: boolean;
  signal_strength: "strong" | "normal" | "none" | "insufficient_data";
}

interface NameMap {
  [symbol: string]: string | null;
}

export default async function RankPage() {
  const sb = createClient();

  const [{ data: ranks }, { data: signals }, { data: settingRow }] = await Promise.all([
    // M9.3:改讀 v_rank_with_cost(多了 cost_per_lot_ntd 給 budget filter)
    // 撈多一些(限 80 檔)再 SSR filter,因為 budget filter 後可能剩很少
    sb
      .from("v_rank_with_cost")
      .select("*")
      .order("expected_rank", { ascending: true })
      .limit(80),
    sb.from("v_entry_signal").select("symbol, is_entry_signal, signal_strength"),
    sb
      .from("app_settings")
      .select("value")
      .eq("key", "budget_ntd")
      .maybeSingle(),
  ]);

  const allRows = (ranks as RankWithCostRow[] | null) ?? [];
  const signalRows = (signals as SignalRow[] | null) ?? [];
  const signalMap = new Map<string, SignalRow>(
    signalRows.map((s) => [s.symbol, s] as const),
  );
  const entryCount = signalRows.filter((s) => s.is_entry_signal).length;

  const budgetRaw = (settingRow as { value: number | string | null } | null)?.value ?? 0;
  const budget = Number(budgetRaw);
  const hasBudget = Number.isFinite(budget) && budget > 0;

  // SSR 預算 filter:budget=0 不 filter,否則 cost_per_lot_ntd <= budget(null cost 一律過濾掉)
  const filteredRows = hasBudget
    ? allRows.filter((r) => {
        const c = Number(r.cost_per_lot_ntd);
        return Number.isFinite(c) && c > 0 && c <= budget;
      })
    : allRows;

  // 顯示 top 30(filter 後)
  const rankRows = filteredRows.slice(0, 30);
  const matchedCount = filteredRows.length;
  const allCount = allRows.length;

  // 拉 name (industry_stocks + stock_universe + etf_metadata)
  const symbols = rankRows.map((r) => r.symbol);
  const nameMap: NameMap = {};
  if (symbols.length > 0) {
    const [is, su, em] = await Promise.all([
      sb.from("industry_stocks").select("symbol, name").in("symbol", symbols),
      sb.from("stock_universe").select("symbol, name").in("symbol", symbols),
      sb.from("etf_metadata").select("symbol, name").in("symbol", symbols),
    ]);
    for (const r of (em.data as { symbol: string; name: string | null }[] | null) ?? []) {
      if (r.name) nameMap[r.symbol] = r.name;
    }
    for (const r of (su.data as { symbol: string; name: string | null }[] | null) ?? []) {
      if (!nameMap[r.symbol] && r.name) nameMap[r.symbol] = r.name;
    }
    for (const r of (is.data as { symbol: string; name: string | null }[] | null) ?? []) {
      if (!nameMap[r.symbol] && r.name) nameMap[r.symbol] = r.name;
    }
  }

  return (
    <div className="space-y-6">
      <header className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold">多因子排名 (Top 30)</h1>
          <div className="text-sm text-zinc-400">
            進場訊號 (
            <span className="text-yellow-400">⭐</span>):
            <span className="ml-1 font-semibold text-yellow-300 tabular-nums">{entryCount}</span>{" "}
            檔
          </div>
        </div>
        <BudgetHeader
          hasBudget={hasBudget}
          budget={budget}
          matched={matchedCount}
          all={allCount}
        />
        <p className="mt-2 text-xs text-zinc-500">
          權重(短中線):基本面 40% / 動能 30% / 反轉 10% / 籌碼 20%(可在{" "}
          <Link href="/settings" className="text-blue-400 hover:underline">
            Settings
          </Link>{" "}
          調)。資料缺維度時權重 reallocate 給其他維度。
        </p>
      </header>

      {rankRows.length === 0 ? (
        <EmptyState hasBudget={hasBudget} budget={budget} />
      ) : (
        <RankTable rows={rankRows} nameMap={nameMap} signalMap={signalMap} />
      )}

      <Legend />
    </div>
  );
}

function BudgetHeader({
  hasBudget,
  budget,
  matched,
  all,
}: {
  hasBudget: boolean;
  budget: number;
  matched: number;
  all: number;
}) {
  if (!hasBudget) {
    return (
      <p className="mt-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
        未設預算 → 顯示全部 ({all} 檔)。設預算可在{" "}
        <Link href="/settings" className="text-blue-400 hover:underline">
          /settings
        </Link>{" "}
        調整。
      </p>
    );
  }
  const wan = (budget / 10000).toFixed(1);
  return (
    <p className="mt-2 rounded border border-emerald-900/40 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200">
      依預算 <span className="font-semibold tabular-nums">{wan} 萬</span> 過濾,符合{" "}
      <span className="font-semibold tabular-nums">{matched}</span> 檔(共 {all} 檔)
    </p>
  );
}

function EmptyState({ hasBudget, budget }: { hasBudget: boolean; budget: number }) {
  if (hasBudget) {
    const wan = (budget / 10000).toFixed(1);
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center">
        <p className="text-zinc-400">預算 {wan} 萬內沒有符合的標的</p>
        <p className="mt-2 text-sm text-zinc-500">
          可在{" "}
          <Link href="/settings" className="text-blue-400 hover:underline">
            /settings
          </Link>{" "}
          調高預算或設 0 顯示全部
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center">
      <p className="text-zinc-400">尚無排名資料</p>
      <p className="mt-2 text-sm text-zinc-500">
        確認 stock_universe 已 seed,且 price_daily 有近 60 日資料(M9 動能因子需要 60d MA)
      </p>
    </div>
  );
}

function RankTable({
  rows,
  nameMap,
  signalMap,
}: {
  rows: RankWithCostRow[];
  nameMap: NameMap;
  signalMap: Map<string, SignalRow>;
}) {
  return (
    <section>
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-left text-xs text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-right">#</th>
              <th className="px-3 py-2">股號</th>
              <th className="px-3 py-2">名稱</th>
              <th className="px-3 py-2 text-right">總分</th>
              <th className="px-3 py-2 text-right">基本面</th>
              <th className="px-3 py-2 text-right">動能</th>
              <th className="px-3 py-2 text-right">反轉</th>
              <th className="px-3 py-2 text-right">籌碼</th>
              <th className="px-3 py-2 text-right">現價</th>
              <th className="px-3 py-2 text-right">1 張成本</th>
              <th className="px-3 py-2 text-right">20 日%</th>
              <th className="px-3 py-2 text-right">RSI14</th>
              <th className="px-3 py-2 text-right">距 60d 高</th>
              <th className="px-3 py-2 text-center">訊號</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const sig = signalMap.get(r.symbol);
              const isEntry = sig?.is_entry_signal ?? false;
              const strength = sig?.signal_strength ?? "none";
              return (
                <tr
                  key={r.symbol}
                  className={`border-t border-zinc-800 ${isEntry ? "bg-yellow-950/15" : ""}`}
                >
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                    {r.expected_rank}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    <Link
                      href={`/stocks/${r.symbol}`}
                      className="text-blue-400 hover:text-blue-300 hover:underline"
                    >
                      {r.symbol}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-zinc-300">{nameMap[r.symbol] ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-semibold">
                      {fmtPctValue(r.weighted_score)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <DimensionCell
                      pos={r.fund_count_pos}
                      total={r.fund_count_total}
                      pct={r.fund_score_pct}
                      color="text-blue-400"
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <DimensionCell
                      pos={r.mom_count_pos}
                      total={r.mom_count_total}
                      pct={r.mom_score_pct}
                      color="text-amber-400"
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <DimensionCell
                      pos={r.rev_count_pos}
                      total={r.rev_count_total}
                      pct={r.rev_score_pct}
                      color="text-violet-400"
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <DimensionCell
                      pos={r.chip_count_pos}
                      total={r.chip_count_total}
                      pct={r.chip_score_pct}
                      color="text-emerald-400"
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtMoney(r.current_price ?? r.latest_close, 2)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                    {fmtCost(r.cost_per_lot_ntd)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.ret_20d_pct)}`}>
                    {fmtPct(r.ret_20d_pct)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.rsi14, 1)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                    {fmtPct(toMaybeNeg(r.off_high_60d_pct))}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {isEntry ? (
                      <span
                        title={`進場訊號:${strength}`}
                        className={`text-lg ${
                          strength === "strong" ? "text-yellow-300" : "text-yellow-500"
                        }`}
                      >
                        ⭐
                      </span>
                    ) : (
                      <span className="text-zinc-700">·</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DimensionCell({
  pos,
  total,
  pct,
  color,
}: {
  pos: number;
  total: number;
  pct: number | string | null;
  color: string;
}) {
  if (total === 0) {
    return <span className="text-zinc-600">—</span>;
  }
  return (
    <span title={`${pos} / ${total} 通過 = ${fmtPctValue(pct)}`}>
      <span className={color}>{pos}</span>
      <span className="text-zinc-600">/{total}</span>
    </span>
  );
}

function fmtPctValue(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

// 1 張成本顯示「11.4 萬」/「3,250」這種混合格式
//   ≥ 10000 → X.X 萬
//   < 10000 → X,XXX
function fmtCost(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 萬`;
  return Math.round(v).toLocaleString("zh-TW");
}

// off_high_60d_pct view 算的是「(high - close)/high」即正值表示折價,
// UI 慣例顯示為負值(距高點 -X%),所以反相
function toMaybeNeg(n: string | number | null | undefined): string | number | null {
  if (n == null) return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return -v;
}

function Legend() {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-400">
      <div className="mb-1 font-semibold text-zinc-300">因子說明(共 19 條)</div>
      <ul className="grid grid-cols-1 gap-1 md:grid-cols-2">
        <li>
          <span className="text-blue-400">基本面 (7)</span>:EPS 連 4 季正 / EPS YoY+ / ROE&gt;10% /
          FCF+ / PEG&lt;1.5 / 月營收 YoY+ / 毛利率 YoY+
        </li>
        <li>
          <span className="text-amber-400">動能 (5)</span>:MA20&gt;MA60 黃金交叉 / 20 日 vs 60 日報酬加速 /
          RSI14&gt;50 轉強 / 20 日新高+量增 2x 突破 / 站上 MA200 續強
        </li>
        <li>
          <span className="text-violet-400">反轉 (2)</span>:距 60 日高點折價&gt;10% / 5 日跌幅&gt;3% 且量縮
        </li>
        <li>
          <span className="text-emerald-400">籌碼 (5)</span>:法人 3 日買超 / 融資餘額減 / 借券減 /
          外資持股升 / 法人 3 日 net 占成交量&gt;5%
        </li>
      </ul>
      <div className="mt-2 text-zinc-500">
        進場訊號:月營收 YoY 必過 + 基本面 ≥ 3/7 + 動能 ≥ 2/5 + 籌碼三層 fallback(≥4 條 → 過 3 / &gt;0 → 過 1 / =0 → 不卡)。
        Strong = 基本面 ≥ 5 + 動能 ≥ 4/5 + 籌碼嚴格。
      </div>
    </div>
  );
}
