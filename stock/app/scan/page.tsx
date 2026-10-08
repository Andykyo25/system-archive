import Link from "next/link";
import { unstable_cache } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { readAll, unwrap } from "@/lib/db";
import type { VerdictLive, VerdictRow } from "@/lib/scan";
import { taipeiDate, type TradePlan } from "@/lib/trade-plan";
import { VerdictBoard } from "./VerdictBoard";
import { PlanItem, type PlanSettings } from "./PlanForms";
import type { RiskContext } from "@/lib/plan-risk";
import { LiveRefresh } from "@/app/_components/LiveRefresh";
import { holdingDates } from "@/lib/holding-analysis";
import type { HoldingEvidence } from "@/lib/holding-decision";
import research from "@/lib/r2p-research.json";

export const dynamic = "force-dynamic";

// v_scan_verdict 已完成所有判讀(R2p 前 3 檔),頁面只負責呈現。
// Plans, settings and account risk stay fresh.
const loadVerdict = unstable_cache(async () => {
  const sb = createClient();
  const result = await readAll<VerdictRow>((from, to) => sb
    .from("v_scan_verdict").select("*")
    .order("score_total", { ascending: false }).order("day_pct", { ascending: false })
    .order("symbol").range(from, to));
  return unwrap(result, "今日看多") ?? [];
}, ["scan:verdict:v3"], { revalidate: 60 });

export default async function ScanPage() {
  const sb = createClient();
  const [rows, liveR, dateR, plansR, riskR, settingsR] =
    await Promise.all([
      loadVerdict(),
      // 盤中閘門不快取:報價每分鐘更新,狀態要即時
      sb.from("v_verdict_live").select("symbol,state,reason,price_now,quoted_at"),
      sb
        .from("price_daily")
        .select("trade_date")
        .order("trade_date", { ascending: false })
        .limit(1),
      readAll<TradePlan>((from, to) =>
        sb
          .from("trade_plans")
          .select("*,holdings_transactions(price,qty,txn_date)")
          .order("created_at", { ascending: false })
          .order("id")
          .range(from, to),
      ),
      sb.from("v_plan_risk_context").select("*").single(),
      sb
        .from("app_settings")
        .select("key,value")
        .in("key", ["verdict_atr_stop_multiple", "plan_slippage_pct"]),
    ]);
  const date = unwrap(dateR, "價格資料日")?.[0]?.trade_date ?? null;
  const today = taipeiDate();
  const symbols = rows.map(r=>r.symbol).sort();
  const rankR = symbols.length ? await sb.from("v_stock_rank")
    .select("symbol,fund_count_pos,fund_count_total,mom_count_pos,mom_count_total,chip_count_pos,chip_count_total")
    .in("symbol",symbols) : {data:[],error:null};
  let dates = {};
  let evidenceError = rankR.error ? "三面因子讀取失敗" : null;
  try { dates = await holdingDates(symbols); } catch { evidenceError = "分析資料時間讀取失敗"; }
  const factors = Object.fromEntries(((rankR.data??[]) as HoldingEvidence[]).map(r=>[r.symbol,r]));
  const timestamps = [...new Set((liveR.data??[]).map(r=>r.quoted_at).filter(Boolean))];
  const quoteR = symbols.length && timestamps.length ? await sb.from('price_intraday_cache')
    .select('symbol,quoted_at,source').in('symbol',symbols).in('quoted_at',timestamps) : {data:[],error:null};
  const quoteSources = Object.fromEntries((quoteR.data??[]).filter(q=>(liveR.data??[]).some(l=>l.symbol===q.symbol && Date.parse(l.quoted_at)===Date.parse(q.quoted_at))).map(q=>[q.symbol,q.source]));
  const plans = (plansR.data ?? []) as TradePlan[];
  const active = plans.filter(
    (p) => p.status === "watching" && p.valid_until >= today,
  );
  const past = plans.filter((p) => !active.includes(p));
  const riskContext = riskR.error ? null : (riskR.data as RiskContext | null);
  // Plan defaults reuse existing settings; a missing key means "no suggestion",
  // never a made-up number.
  const setting = (key: string) => {
    const raw = (
      (settingsR.data ?? []) as { key: string; value: number | string }[]
    ).find((r) => r.key === key)?.value;
    const n = Number(raw);
    return raw != null && Number.isFinite(n) ? n : null;
  };
  const planSettings: PlanSettings = {
    // 今日看多專用(3);持股部位建議用的 atr_stop_multiple 不受影響
    atrStopMultiple: setting("verdict_atr_stop_multiple"),
    slippagePct: setting("plan_slippage_pct"),
  };
  const cash = riskContext?.cash == null ? null : Number(riskContext.cash);
  const live = new Map(
    ((liveR.data ?? []) as VerdictLive[]).map((l) => [l.symbol, l] as const),
  );
  return (
    <div className="space-y-6">
      <LiveRefresh />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">今日看多</h1>
          <p className="mt-1 text-sm text-slate-400">
            {date ?? "尚無資料"} 收盤 · {rows.length} 檔
          </p>
        </div>
        <Link href="/track" className="text-sm text-sky-300">
          成績單 →
        </Link>
      </header>
      <p className="text-sm leading-relaxed text-slate-300">盤後型態候選 → 檢查三面資料與風險 → 訂交易計畫。上榜與條件通過數都不代表獲利機率。</p>
      {cash != null && cash <= 0 && (
        <p className="rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          資金已全數投入，新計畫股數會是 0。
        </p>
      )}
      <VerdictBoard
        rows={rows}
        live={live}
        today={today}
        plansAvailable={!plansR.error}
        riskContext={riskContext}
        settings={planSettings}
        factors={factors}
        dates={dates}
        evidenceError={evidenceError}
        liveAvailable={!liveR.error}
        quoteSources={quoteSources}
      />
      <details className="rounded-2xl border border-line bg-surface-1 p-4">
        <summary className="cursor-pointer text-sm font-medium text-slate-200">R2p 歷史驗證與風險 · {research.trades.toLocaleString()} 筆模擬交易</summary>
        <div className="mt-4 space-y-3 text-sm text-slate-300">
          <p>{research.from}–{research.to} · 檢驗 {research.checkedOn} · 版本 {research.strategy}</p>
          <p>扣成本勝率 {research.netWinPct.toFixed(1)}% · 平均單筆淨報酬 {research.meanNetPct.toFixed(2)}% · 按訊號日等權平均 {research.dayWeightedMeanNetPct.toFixed(2)}% · 最差單筆淨報酬 {research.worstNetPct.toFixed(1)}%</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{research.years.map(y=><p key={y.year}>{y.year}<span className="block tabular-nums">平均淨報酬 {y.mean.toFixed(2)}%</span></p>)}</div>
          <ul className="space-y-2 text-xs leading-relaxed text-slate-400">{research.limits.map(limit=><li key={limit}>{limit}</li>)}</ul>
          <Link href="/track" className="inline-block text-sky-300">檢查前向追蹤 →</Link>
        </div>
      </details>
      <section id="plans" className="scroll-mt-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">我的交易計畫</h2>
          <Link href="/holdings" className="shrink-0 text-sm text-sky-300">
            持股管理 →
          </Link>
        </div>
        {plansR.error ? (
          <p role="alert" className="text-sm text-amber-200">
            交易計畫載入失敗
          </p>
        ) : active.length ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {active.map((p) => (
              <PlanItem key={p.id} plan={p} today={today} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">尚無有效計畫</p>
        )}
        {past.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm text-slate-400">
              已結束的計畫（{past.length}）
            </summary>
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              {past.map((p) => (
                <PlanItem key={p.id} plan={p} today={today} />
              ))}
            </div>
          </details>
        )}
      </section>
    </div>
  );
}
