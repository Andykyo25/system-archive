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

// 構造 /rank URL,保留兩個 toggle state(防止互相覆蓋)
function buildRankHref(opts: { ignoreBudget?: boolean; focus?: number }): string {
  const qs: string[] = [];
  if (opts.ignoreBudget) qs.push("ignore_budget=1");
  if (opts.focus === 5) qs.push("focus=5");
  return qs.length > 0 ? `/rank?${qs.join("&")}` : "/rank";
}

export default async function RankPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sb = createClient();
  const sp = await searchParams;
  // ?ignore_budget=1 → 不套用預算 filter(一鍵切「不考慮資產」)
  const ignoreBudget = sp.ignore_budget === "1";
  // ?focus=5 → 高集中模式(M9.4a backtest alpha -4.22%);預設 30 維持原行為
  const focus = sp.focus === "5" ? 5 : 30;

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
  // 全市場 entry signal 總數(給 Top 30 mode 顯示用)
  const totalEntryCount = signalRows.filter((s) => s.is_entry_signal).length;

  // budget_ntd 儲存值單位是「萬」NT$(因 app_settings.value 限制 numeric(10,6))
  // 讀出來 × 10000 變成 NT$ 才能跟 cost_per_lot_ntd 比較
  const budgetRaw = (settingRow as { value: number | string | null } | null)?.value ?? 0;
  const budgetWan = Number(budgetRaw);
  const budget = Number.isFinite(budgetWan) ? budgetWan * 10000 : 0;
  const hasBudget = Number.isFinite(budget) && budget > 0;

  // Filter 套用條件:有設預算 且 沒按「忽略」toggle
  const shouldFilter = hasBudget && !ignoreBudget;

  // SSR 預算 filter:不 filter 時直接 allRows;filter 時剔除 cost null / 超預算
  const filteredRows = shouldFilter
    ? allRows.filter((r) => {
        const c = Number(r.cost_per_lot_ntd);
        return Number.isFinite(c) && c > 0 && c <= budget;
      })
    : allRows;

  // 預算內符合的檔數(無論 toggle 在哪 state 都算給 segmented control 顯示)
  const inBudgetCount = hasBudget
    ? allRows.filter((r) => {
        const c = Number(r.cost_per_lot_ntd);
        return Number.isFinite(c) && c > 0 && c <= budget;
      }).length
    : 0;

  // 顯示 top K (filter 後),K 由 focus 決定(5 高集中 / 30 全覽)
  const rankRows = filteredRows.slice(0, focus);
  const allCount = allRows.length;

  // 當前 view(top K)中亮 ⭐ 的個數 — 驗證「值得進場」標的密度
  const viewEntryCount = rankRows.filter(
    (r) => signalMap.get(r.symbol)?.is_entry_signal,
  ).length;
  const viewStrongCount = rankRows.filter(
    (r) => signalMap.get(r.symbol)?.signal_strength === "strong",
  ).length;

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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">
              多因子排名 (Top {focus})
            </h1>
            <p className="mt-1 text-xs text-zinc-500">
              當前範圍 ⭐{" "}
              <span className="font-semibold text-yellow-300 tabular-nums">
                {viewEntryCount}
              </span>{" "}
              / {rankRows.length} 檔
              {viewStrongCount > 0 && (
                <>
                  {" "}
                  · 含{" "}
                  <span className="font-semibold text-yellow-200 tabular-nums">
                    {viewStrongCount}
                  </span>{" "}
                  strong
                </>
              )}
              {" · "}全市場共 {totalEntryCount} 檔 entry signal
            </p>
          </div>
          <FocusToggle focus={focus} ignoreBudget={ignoreBudget} />
        </div>
        <BudgetHeader
          hasBudget={hasBudget}
          budget={budget}
          inBudgetCount={inBudgetCount}
          allCount={allCount}
          ignoreBudget={ignoreBudget}
          focus={focus}
        />
        <p className="mt-2 text-xs text-zinc-500">
          權重(短中線):基本面 40% / 動能 30% / 反轉 10% / 籌碼 20%(可在{" "}
          <Link href="/settings" className="text-blue-400 hover:underline">
            Settings
          </Link>{" "}
          調)。資料缺維度時權重 reallocate 給其他維度。Top 5 = M9.4a backtest 集中度策略(2024 alpha −4.22% / Sharpe 1.50)。
        </p>
      </header>

      {rankRows.length === 0 ? (
        <EmptyState
          hasBudget={hasBudget}
          budget={budget}
          ignoreBudget={ignoreBudget}
          focus={focus}
        />
      ) : (
        <RankTable rows={rankRows} nameMap={nameMap} signalMap={signalMap} />
      )}

      <Legend />
    </div>
  );
}

function FocusToggle({
  focus,
  ignoreBudget,
}: {
  focus: number;
  ignoreBudget: boolean;
}) {
  // 精選 Top 5 (M9.4a backtest 集中度策略,2024 alpha -4.22) vs 完整 Top 30 (預設,全覽)
  const tabBase =
    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition";
  const tabActiveFocus = "bg-amber-600 text-white shadow-sm";
  const tabActiveFull = "bg-zinc-700 text-white shadow-sm";
  const tabIdle = "text-zinc-400 hover:text-zinc-200";
  return (
    <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-1">
      <Link
        href={buildRankHref({ ignoreBudget, focus: 5 })}
        className={`${tabBase} ${focus === 5 ? tabActiveFocus : tabIdle}`}
        title="M9.4a 集中度策略(backtest 2024 alpha -4.22% / Sharpe 1.50)"
      >
        🎯 精選 Top 5
      </Link>
      <Link
        href={buildRankHref({ ignoreBudget })}
        className={`${tabBase} ${focus === 30 ? tabActiveFull : tabIdle}`}
      >
        完整 Top 30
      </Link>
    </div>
  );
}

function BudgetHeader({
  hasBudget,
  budget,
  inBudgetCount,
  allCount,
  ignoreBudget,
  focus,
}: {
  hasBudget: boolean;
  budget: number;
  inBudgetCount: number;
  allCount: number;
  ignoreBudget: boolean;
  focus: number;
}) {
  // 沒設預算 → toggle 沒意義,維持原訊息
  if (!hasBudget) {
    return (
      <p className="mt-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
        未設預算 → 顯示全部 ({allCount} 檔)。設預算可在{" "}
        <Link href="/settings" className="text-blue-400 hover:underline">
          /settings
        </Link>{" "}
        調整。
      </p>
    );
  }

  // Segmented control 2 tab(SSR Link 切 URL,保留 refresh-safe 狀態)
  const wan = (budget / 10000).toFixed(1);
  const tabBase =
    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition";
  const tabActiveBudget = "bg-emerald-600 text-white shadow-sm";
  const tabActiveAll = "bg-zinc-700 text-white shadow-sm";
  const tabIdle = "text-zinc-400 hover:text-zinc-200";

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-1">
        <Link
          href={buildRankHref({ focus: focus === 5 ? 5 : undefined })}
          className={`${tabBase} ${!ignoreBudget ? tabActiveBudget : tabIdle}`}
        >
          依預算 {wan} 萬
          <span className="rounded bg-black/30 px-1.5 py-0.5 tabular-nums">
            {inBudgetCount}
          </span>
        </Link>
        <Link
          href={buildRankHref({ ignoreBudget: true, focus: focus === 5 ? 5 : undefined })}
          className={`${tabBase} ${ignoreBudget ? tabActiveAll : tabIdle}`}
        >
          全部
          <span className="rounded bg-black/30 px-1.5 py-0.5 tabular-nums">{allCount}</span>
        </Link>
      </div>
      <span className="text-xs text-zinc-500">
        預算可在{" "}
        <Link href="/settings" className="text-blue-400 hover:underline">
          /settings
        </Link>{" "}
        調整
      </span>
    </div>
  );
}

function EmptyState({
  hasBudget,
  budget,
  ignoreBudget,
  focus,
}: {
  hasBudget: boolean;
  budget: number;
  ignoreBudget: boolean;
  focus: number;
}) {
  // 設了預算 + 沒按忽略 → 是「預算內沒符合」(常見於 focus=5 高集中模式)
  if (hasBudget && !ignoreBudget) {
    const wan = (budget / 10000).toFixed(1);
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center">
        <p className="text-zinc-400">
          {focus === 5 ? "精選 Top 5" : `Top ${focus}`} 中沒有預算 {wan} 萬內的標的
        </p>
        <p className="mt-2 text-sm text-zinc-500">
          可上方點「全部」忽略預算,或切「完整 Top 30」看更多,或在{" "}
          <Link href="/settings" className="text-blue-400 hover:underline">
            /settings
          </Link>{" "}
          調高預算
        </p>
      </div>
    );
  }
  // 沒設預算 或 按了忽略 → 真的沒任何排名資料
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
