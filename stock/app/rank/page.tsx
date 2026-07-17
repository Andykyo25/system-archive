import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fmtMoney, fmtPct, pctColor } from "@/app/_components/Format";
import { INDUSTRY_SOURCE, GATE_THRESHOLD, SOURCE_META } from "@/app/_components/overseas-map";

export const dynamic = "force-dynamic";

// v_entry_quality(價位質量層):entry_zone 四態 + 耐心價
interface EntryQualityRow {
  symbol: string;
  dev_ma20_pct: number | string | null;
  off_high_pct: number | string | null;
  boll_pctb: number | string | null;
  vol_ratio_5_20: number | string | null;
  entry_zone: "chase" | "neutral" | "pullback" | "broken" | "unknown";
}

// entry_zone → 顯示(走 B 資訊呈現:價位區資訊,非買賣訊號;籌碼/訊號燈仍要並看)
const ZONE_META: Record<
  EntryQualityRow["entry_zone"],
  { label: string; cls: string; title: string }
> = {
  pullback: { label: "回檔✓", cls: "text-green-400", title: "回檔至支撐:偏離 MA20 ±5% 內且距 60d 高 ≥8%(價位區資訊,仍需並看籌碼/訊號)" },
  neutral: { label: "中性", cls: "text-zinc-500", title: "非追高亦非回檔支撐區" },
  chase: { label: "追高", cls: "text-red-400", title: "追高區:偏離 MA20>+10% 或 RSI>75 或布林 %B>85" },
  broken: { label: "破壞", cls: "text-sky-400", title: "趨勢破壞:跌破 MA60 且距 60d 高 >25%,別接刀" },
  unknown: { label: "—", cls: "text-zinc-600", title: "資料不足" },
};

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
  ret_5d_pct: number | string | null;
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

// 前向追蹤(paper_picks 凍結批,join 即時價算浮動)
interface PaperPickRow {
  rank: number | null;
  symbol: string;
  is_benchmark: boolean;
  entry_px: number | string | null;
}

// 把 numeric | string | null 轉成 number | null(L13:supabase numeric 回字串)
function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 平均(排除 null),空陣列回 null
function avgOrNull(xs: (number | null)[]): number | null {
  const vals = xs.filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// 構造 /rank URL,保留兩個 toggle state(防止互相覆蓋)
function buildRankHref(opts: { ignoreBudget?: boolean; focus?: number }): string {
  const qs: string[] = [];
  if (opts.ignoreBudget) qs.push("ignore_budget=1");
  // M9.4a:focus=5/30 為臨時覆寫(優先於 default_top_n setting)
  if (opts.focus === 5) qs.push("focus=5");
  else if (opts.focus === 30) qs.push("focus=30");
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

  const [
    { data: ranks },
    { data: signals },
    { data: settingRow },
    { data: topNRow },
    { data: paperPicksData },
  ] = await Promise.all([
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
    // M9.4a:default_top_n setting(預設精選檔數)
    sb
      .from("app_settings")
      .select("value")
      .eq("key", "default_top_n")
      .maybeSingle(),
    // 前向追蹤:系統凍結的真前向批(2026-05-16 cohort,top10 + 0050 benchmark)
    sb
      .from("paper_picks")
      .select("rank, symbol, is_benchmark, entry_px")
      .eq("cohort_date", "2026-05-16"),
  ]);

  // M9.4a:default_top_n → /rank 預設精選檔數(純顯示偏好,非績效宣稱)。
  // 註:早期「top5 集中度勝」的 OOS alpha(+24.19)經 C1 PIT 前視偏誤修正後已不成立
  //   (修後 top5 2024 −50.65 / 2025 −9.02,見 L48 / todo);實際回測以 /backtest 為準。
  // 防呆:updateSetting 不做範圍檢查,故此處 clamp 整數 5~50,否則 fallback 30。
  const rawTopN = Number(
    (topNRow as { value: number | string | null } | null)?.value ?? 30,
  );
  const defaultTopN =
    Number.isInteger(rawTopN) && rawTopN >= 5 && rawTopN <= 50 ? rawTopN : 30;
  // ?focus= 臨時覆寫優先於 setting(focus=5/30);否則用 default_top_n
  const focus =
    sp.focus === "5" ? 5 : sp.focus === "30" ? 30 : defaultTopN;

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

  // 拉 name + 昨收(price_daily) + 前向追蹤即時價(v_latest_price_realtime)— 全並行
  const symbols = rankRows.map((r) => r.symbol);
  const paperPicks = (paperPicksData as PaperPickRow[] | null) ?? [];
  const paperSymbols = paperPicks.map((p) => p.symbol);

  // 昨收近窗:price_daily .in() 全歷史會撞 supabase 1000 row 上限(30 檔 × 320 天
  //   ≈ 9600 row)→ 多數 symbol 被靜默截斷拿不到昨收(已實證 28/30 變 null)。
  //   改抓「< today 且近 12 天」把 row 壓到 ~240 < 1000,每檔取最新一筆 = 昨收。
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);

  const nameMap: NameMap = {};
  const prevCloseMap = new Map<string, number>();
  const realtimeMap = new Map<string, number>();

  const overseasSince = new Date(Date.now() - 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  const [nameRes, eqRes, overseasRes, prevRes, fwdRes] = await Promise.all([
    symbols.length > 0
      ? Promise.all([
          sb.from("industry_stocks").select("symbol, name, industry").in("symbol", symbols),
          sb.from("stock_universe").select("symbol, name").in("symbol", symbols),
          sb.from("etf_metadata").select("symbol, name").in("symbol", symbols),
        ])
      : Promise.resolve(null),
    // 價位質量層(v_entry_quality):entry_zone 四態 + 耐心價
    symbols.length > 0
      ? sb.from("v_entry_quality").select("*").in("symbol", symbols)
      : Promise.resolve({ data: null }),
    // 海外 gate:近 7 天各源,前端各取最新一筆
    sb
      .from("overseas_indicators")
      .select("symbol, quoted_date, change_pct")
      .gte("quoted_date", overseasSince)
      .order("quoted_date", { ascending: false }),
    symbols.length > 0
      ? sb
          .from("price_daily")
          .select("symbol, close, trade_date")
          .in("symbol", symbols)
          .lt("trade_date", today)
          .gte("trade_date", since)
          .order("symbol", { ascending: true })
          .order("trade_date", { ascending: false })
      : Promise.resolve({ data: null }),
    paperSymbols.length > 0
      ? sb
          .from("v_latest_price_realtime")
          .select("symbol, current_price")
          .in("symbol", paperSymbols)
      : Promise.resolve({ data: null }),
  ]);

  const industryMap = new Map<string, string>();
  if (nameRes) {
    const [is, su, em] = nameRes;
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
      if (r.industry) industryMap.set(r.symbol, r.industry);
    }
  }

  // 價位質量 map(symbol → v_entry_quality row)
  const eqMap = new Map<string, EntryQualityRow>();
  for (const r of (eqRes.data as EntryQualityRow[] | null) ?? []) {
    eqMap.set(r.symbol, r);
  }

  // 海外 gate:各源最新一筆 → 產業對應源隔夜 ≤ GATE_THRESHOLD 且 verified → 當日勿進
  const srcChgMap = new Map<string, number>();
  for (const r of (overseasRes.data as
    | { symbol: string; quoted_date: string; change_pct: number | string | null }[]
    | null) ?? []) {
    if (!srcChgMap.has(r.symbol)) {
      const c = toNum(r.change_pct);
      if (c != null) srcChgMap.set(r.symbol, c);
    }
  }
  const gateMap = new Map<string, { src: string; chg: number }>();
  for (const s of symbols) {
    const ind = industryMap.get(s);
    const m = ind ? INDUSTRY_SOURCE[ind] : undefined;
    if (!m?.verified) continue;
    const chg = srcChgMap.get(m.src);
    if (chg != null && chg <= GATE_THRESHOLD) gateMap.set(s, { src: m.src, chg });
  }

  // 每檔取最新一筆(已 order by trade_date desc,首見即昨收)
  for (const row of (prevRes.data as { symbol: string; close: number | string | null }[] | null) ??
    []) {
    if (!prevCloseMap.has(row.symbol)) {
      const c = toNum(row.close);
      if (c != null) prevCloseMap.set(row.symbol, c);
    }
  }

  for (const row of (fwdRes.data as
    | { symbol: string; current_price: number | string | null }[]
    | null) ?? []) {
    const c = toNum(row.current_price);
    if (c != null) realtimeMap.set(row.symbol, c);
  }

  // 今日漲幅 map(current_price / prev_close - 1)。null = 無昨收 → UI 顯示「—」
  const todayChgMap = new Map<string, number | null>();
  for (const r of rankRows) {
    const cp = toNum(r.current_price);
    const pc = prevCloseMap.get(r.symbol) ?? null;
    todayChgMap.set(
      r.symbol,
      cp != null && pc != null && pc > 0 ? (cp / pc - 1) * 100 : null,
    );
  }

  // 前向追蹤(凍結名單浮動%)= (即時價 / entry_px - 1) * 100
  const fwdRet = (p: PaperPickRow): number | null => {
    const ep = toNum(p.entry_px);
    const cp = realtimeMap.get(p.symbol) ?? null;
    return ep != null && cp != null && ep > 0 ? (cp / ep - 1) * 100 : null;
  };
  const fwdTop5 = avgOrNull(
    paperPicks.filter((p) => !p.is_benchmark && p.rank != null && p.rank <= 5).map(fwdRet),
  );
  const fwdTop10 = avgOrNull(
    paperPicks.filter((p) => !p.is_benchmark && p.rank != null && p.rank <= 10).map(fwdRet),
  );
  const fwdBench = avgOrNull(paperPicks.filter((p) => p.is_benchmark).map(fwdRet));
  const hasFwd = paperPicks.length > 0;

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-4">
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
          <FocusToggle focus={focus} ignoreBudget={ignoreBudget} defaultTopN={defaultTopN} />
        </div>
        <BudgetHeader
          hasBudget={hasBudget}
          budget={budget}
          inBudgetCount={inBudgetCount}
          allCount={allCount}
          ignoreBudget={ignoreBudget}
          focus={focus}
        />
      </header>

      {rankRows.length === 0 ? (
        <EmptyState
          hasBudget={hasBudget}
          budget={budget}
          ignoreBudget={ignoreBudget}
          focus={focus}
        />
      ) : (
        <>
          <PortfolioSummaryCard
            hasFwd={hasFwd}
            fwdTop5={fwdTop5}
            fwdTop10={fwdTop10}
            fwdBench={fwdBench}
          />
          <RankTable
            rows={rankRows}
            nameMap={nameMap}
            signalMap={signalMap}
            todayChgMap={todayChgMap}
            eqMap={eqMap}
            gateMap={gateMap}
          />
        </>
      )}

      <Legend />
    </div>
  );
}

function FocusToggle({
  focus,
  ignoreBudget,
  defaultTopN,
}: {
  focus: number;
  ignoreBudget: boolean;
  defaultTopN: number;
}) {
  // M9.4a:Top 5 集中度 / Top 30 全覽 為臨時覆寫(?focus=,優先於 setting)。
  // 預設檔數由 default_top_n setting 控制(/settings),非此處。
  const tabBase =
    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition";
  const tabActiveFocus = "bg-amber-600 text-white shadow-sm";
  const tabActiveFull = "bg-zinc-700 text-white shadow-sm";
  const tabIdle = "text-zinc-400 hover:text-zinc-200";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-xl border border-white/[0.06] bg-zinc-950/60 p-1">
        <Link
          href={buildRankHref({ ignoreBudget, focus: 5 })}
          className={`${tabBase} ${focus === 5 ? tabActiveFocus : tabIdle}`}
          title="集中:只看排名前 5(較集中、波動較大;績效以 /backtest 為準)"
        >
          🎯 Top 5
        </Link>
        <Link
          href={buildRankHref({ ignoreBudget, focus: 30 })}
          className={`${tabBase} ${focus === 30 ? tabActiveFull : tabIdle}`}
        >
          Top 30
        </Link>
      </div>
      <span className="text-xs text-zinc-500">
        預設 Top {defaultTopN}(可在{" "}
        <Link href="/settings" className="text-blue-400 hover:underline">
          /settings
        </Link>{" "}
        改 default_top_n)
      </span>
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
      <p className="mt-2 rounded border border-white/[0.06] bg-zinc-950/80 px-3 py-2 text-xs text-zinc-400">
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
      <div className="inline-flex rounded-xl border border-white/[0.06] bg-zinc-950/60 p-1">
        <Link
          href={buildRankHref({ focus: focus === 5 ? 5 : focus === 30 ? 30 : undefined })}
          className={`${tabBase} ${!ignoreBudget ? tabActiveBudget : tabIdle}`}
        >
          依預算 {wan} 萬
          <span className="rounded bg-black/30 px-1.5 py-0.5 tabular-nums">
            {inBudgetCount}
          </span>
        </Link>
        <Link
          href={buildRankHref({ ignoreBudget: true, focus: focus === 5 ? 5 : focus === 30 ? 30 : undefined })}
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
      <div className="rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-8 text-center">
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
    <div className="rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-8 text-center">
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
  todayChgMap,
  eqMap,
  gateMap,
}: {
  rows: RankWithCostRow[];
  nameMap: NameMap;
  signalMap: Map<string, SignalRow>;
  todayChgMap: Map<string, number | null>;
  eqMap: Map<string, EntryQualityRow>;
  gateMap: Map<string, { src: string; chg: number }>;
}) {
  return (
    <section>
      {/* 手機卡牌版(md 以下):16 欄橫滑體驗差,改整卡可點直列 */}
      <div className="space-y-2 md:hidden">
        {rows.map((r) => {
          const sig = signalMap.get(r.symbol);
          const isEntry = sig?.is_entry_signal ?? false;
          const strength = sig?.signal_strength ?? "none";
          const chg = todayChgMap.get(r.symbol) ?? null;
          return (
            <Link
              key={r.symbol}
              href={`/stocks/${r.symbol}`}
              className={`block rounded-xl border border-white/[0.06] px-3 py-2.5 ${
                isEntry ? "bg-yellow-950/15" : "bg-zinc-900"
              }`}
            >
              <div className="flex items-baseline justify-between">
                <span className="flex items-baseline gap-2">
                  <span className="text-xs tabular-nums text-zinc-500">
                    #{r.expected_rank}
                  </span>
                  <span className="font-mono text-blue-400">{r.symbol}</span>
                  <span className="text-sm text-zinc-300">
                    {nameMap[r.symbol] ?? ""}
                  </span>
                  {isEntry && (
                    <span
                      className={
                        strength === "strong" ? "text-yellow-300" : "text-yellow-500"
                      }
                    >
                      ⭐
                    </span>
                  )}
                </span>
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-semibold tabular-nums">
                  {fmtPctValue(r.weighted_score)}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 text-sm tabular-nums">
                <span>{fmtMoney(r.current_price ?? r.latest_close, 2)}</span>
                <span>
                  今日 <TodayChangeCell chg={chg} />
                </span>
                <ZoneCell eq={eqMap.get(r.symbol)} gate={gateMap.get(r.symbol)} />
                <span className={pctColor(r.ret_5d_pct)}>
                  5日 {fmtPct(r.ret_5d_pct)}
                </span>
                <span className={pctColor(r.ret_20d_pct)}>
                  20日 {fmtPct(r.ret_20d_pct)}
                </span>
                <span className="text-zinc-400">RSI {fmtMoney(r.rsi14, 1)}</span>
              </div>
              <div className="mt-1 text-xs tabular-nums text-zinc-500">
                <span className="text-blue-400">
                  基 {r.fund_count_pos}/{r.fund_count_total}
                </span>
                {" · "}
                <span className="text-amber-400">
                  動 {r.mom_count_pos}/{r.mom_count_total}
                </span>
                {" · "}
                <span className="text-violet-400">
                  反 {r.rev_count_pos}/{r.rev_count_total}
                </span>
                {" · "}
                <span className="text-emerald-400">
                  籌 {r.chip_count_pos}/{r.chip_count_total}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
      <div className="hidden overflow-x-auto rounded-2xl border border-white/[0.06] bg-zinc-900/60 md:block">
        <table className="w-full text-sm">
          <thead className="border-b border-white/[0.06] text-left text-[11px] uppercase tracking-wider text-zinc-500">
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
              <th className="px-3 py-2 text-right" title="今日漲幅 = 現價 / 昨收 − 1。≥ +9.5% 標 🔴 漲停">
                今日%
              </th>
              <th className="px-3 py-2 text-center" title="價位質量(v_entry_quality):回檔✓ 回檔至支撐 / 中性 / 追高 / 破壞。⛔ = 對應海外源隔夜大跌,今日勿進(已驗證下檔領先)">
                價位
              </th>
              <th className="px-3 py-2 text-right">1 張成本</th>
              <th className="px-3 py-2 text-right" title="近 5 交易日(≈一週)回看報酬">
                近 5 日%
              </th>
              <th className="px-3 py-2 text-right" title="近 20 交易日(≈一月)回看報酬">
                20 日%
              </th>
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
                  className={`border-t border-white/[0.04] ${isEntry ? "bg-yellow-950/15" : ""}`}
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
                  <td className="px-3 py-2 text-right tabular-nums">
                    <TodayChangeCell chg={todayChgMap.get(r.symbol) ?? null} />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <ZoneCell eq={eqMap.get(r.symbol)} gate={gateMap.get(r.symbol)} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                    {fmtCost(r.cost_per_lot_ntd)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${pctColor(r.ret_5d_pct)}`}>
                    {fmtPct(r.ret_5d_pct)}
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

// 價位質量 cell:zone badge + 偏離 MA20 小字;海外 gate 觸發時 ⛔ 前置
function ZoneCell({
  eq,
  gate,
}: {
  eq: EntryQualityRow | undefined;
  gate: { src: string; chg: number } | undefined;
}) {
  if (!eq) return <span className="text-zinc-700">—</span>;
  const meta = ZONE_META[eq.entry_zone] ?? ZONE_META.unknown;
  const dev = eq.dev_ma20_pct == null ? null : Number(eq.dev_ma20_pct);
  const gateLabel = gate ? SOURCE_META[gate.src]?.label ?? gate.src : null;
  return (
    <span className="inline-flex flex-col items-center">
      <span className={`text-xs font-medium ${meta.cls}`} title={meta.title}>
        {gate && (
          <span
            className="mr-0.5"
            title={`${gateLabel} 隔夜 ${gate.chg.toFixed(2)}% ≤ ${GATE_THRESHOLD}%:已驗證下檔領先,今日勿進場`}
          >
            ⛔
          </span>
        )}
        {meta.label}
      </span>
      {dev != null && (
        <span className="text-[10px] leading-tight text-zinc-600 tabular-nums">
          MA20{dev >= 0 ? "+" : ""}
          {dev.toFixed(1)}%
        </span>
      )}
    </span>
  );
}

// 今日漲幅欄:漲停(>= +9.5%)加 🔴 醒目角標;null(無昨收)顯示「—」。
// 台股配色:漲紅跌綠(用 pctColor / fmtPct)。
function TodayChangeCell({ chg }: { chg: number | null }) {
  if (chg == null) return <span className="text-zinc-600">—</span>;
  const isLimitUp = chg >= 9.5;
  if (isLimitUp) {
    return (
      <span
        title="今日漲停(漲幅 ≥ +9.5%)"
        className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 font-semibold text-red-400"
      >
        <span aria-hidden>🔴</span>
        {fmtPct(chg)}
      </span>
    );
  }
  return <span className={pctColor(chg)}>{fmtPct(chg)}</span>;
}

// 前向追蹤卡(凍結名單真驗證,零前視)。回看報酬區已移除(L48:回看含動能因子
//   系統性偏樂觀,非事先看得準;真實績效以 /backtest 為準)。
function PortfolioSummaryCard({
  hasFwd,
  fwdTop5,
  fwdTop10,
  fwdBench,
}: {
  hasFwd: boolean;
  fwdTop5: number | null;
  fwdTop10: number | null;
  fwdBench: number | null;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-4">
      <h2 className="text-sm font-semibold text-zinc-200">
        前向追蹤(凍結名單再往前看,零前視)
        <span className="ml-2 text-xs font-normal text-zinc-500">5-16 批</span>
      </h2>
      {hasFwd ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm tabular-nums">
          <span>
            <span className="text-zinc-400">Top5 </span>
            <span className={`font-semibold ${pctColor(fwdTop5)}`}>{fmtPct(fwdTop5)}</span>
          </span>
          <span>
            <span className="text-zinc-400">Top10 </span>
            <span className={`font-semibold ${pctColor(fwdTop10)}`}>{fmtPct(fwdTop10)}</span>
          </span>
          <span>
            <span className="text-zinc-400">0050 </span>
            <span className={`font-semibold ${pctColor(fwdBench)}`}>{fmtPct(fwdBench)}</span>
          </span>
        </div>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">尚無前向追蹤批次資料</p>
      )}
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
    <div className="rounded-xl border border-white/[0.06] bg-zinc-950/60 p-4 text-xs text-zinc-400">
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
