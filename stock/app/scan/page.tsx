import Link from "next/link";
import { Crosshair, ArrowRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { readAll, unwrap } from "@/lib/db";
import type { ScanRow } from "@/lib/scan";
import { Suspense } from "react";
import { unstable_cache } from "next/cache";
import { ObservationSummary } from "./ObservationSummary";
import { taipeiDate, type TradePlan } from "@/lib/trade-plan";
import { ScanBoard } from "./ScanBoard";
import { PlanItem, type PlanSettings } from "./PlanForms";
import type { RiskContext } from "@/lib/plan-risk";

export const dynamic = "force-dynamic";

// Cache only daily market research. Plans, settings and account risk stay fresh.
// Read the view once: a separate exact HEAD count can time out even when rows succeed.
const loadScan = unstable_cache(async () => {
  const sb = createClient();
  const result = await readAll<ScanRow>((from, to) => sb
    .from("v_breakout_scan").select("*")
    .order("score_total", { ascending: false }).order("symbol").range(from, to));
  const allRows = unwrap(result, "起漲掃描") ?? [];
  return { rows: allRows.filter((row) => Number(row.score_total) >= 80), total: allRows.length };
}, ["scan:market:v1"], { revalidate: 60 });

export default async function ScanPage() {
  const sb = createClient();
  const [scan, dateR, plansR, riskR, settingsR] =
    await Promise.all([
      loadScan(),
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
        .in("key", ["atr_stop_multiple", "plan_slippage_pct"]),
    ]);
  const { rows, total } = scan;
  const date = unwrap(dateR, "價格資料日")?.[0]?.trade_date ?? null;
  const today = taipeiDate();
  const plans = (plansR.data ?? []) as TradePlan[];
  const active = plans.filter(
    (p) => p.status === "watching" && p.valid_until >= today,
  );
  const past = plans.filter((p) => !active.includes(p));
  const passed = rows.filter((r) => r.passes_all).length;
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
    atrStopMultiple: setting("atr_stop_multiple"),
    slippagePct: setting("plan_slippage_pct"),
  };
  return (
    <div className="space-y-6">
      <header className="relative overflow-hidden rounded-3xl border border-sky-400/15 bg-gradient-to-br from-sky-400/10 via-surface-1 to-surface-1 p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-xs font-medium tracking-wider text-sky-300">
              <Crosshair size={15} aria-hidden /> 起漲研究 · 交易決策
            </p>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
              先找型態，再訂進退
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-400">
              從突破候選中挑選值得追蹤的股票。進場前寫下條件，成交後保留依據，讓每一次決策都能回頭檢驗。
            </p>
          </div>
          <Link
            href="#plans"
            className="inline-flex items-center gap-2 rounded-xl border border-sky-300/20 bg-sky-400/10 px-4 py-2.5 text-sm text-sky-200"
          >
            我的計畫 <span>{active.length}</span>
            <ArrowRight size={15} aria-hidden />
          </Link>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-4 border-t border-white/10 pt-5 sm:grid-cols-4">
          {[
            ["價格資料日", date ?? "尚無資料"],
            ["掃描範圍", `${total} 檔`],
            ["五條件全過", `${passed} 檔`],
            ["高分待確認", `${rows.length - passed} 檔`],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="text-xs text-slate-400">{label}</p>
              <p className="mt-1.5 text-lg font-semibold text-slate-100">
                {value}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-slate-400">
          盤後收盤掃描 · 分數為條件符合程度，非上漲機率 ·{" "}
          <Link
            href="/health"
            className="text-sky-300 underline underline-offset-4"
          >
            檢查資料健康
          </Link>
        </p>
      </header>
      <ScanBoard
        rows={rows}
        today={today}
        plansAvailable={!plansR.error}
        riskContext={riskR.error ? null : (riskR.data as RiskContext | null)}
        settings={planSettings}
      />
      <section id="plans" className="scroll-mt-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">我的交易計畫</h2>
            <p className="mt-1 text-sm text-slate-400">
              保存條件，記錄實際成交；已買入的部位請至持股管理處理。
            </p>
          </div>
          <Link href="/holdings" className="shrink-0 text-sm text-sky-300">
            持股管理 →
          </Link>
        </div>
        {plansR.error ? (
          <p
            role="alert"
            className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-200"
          >
            交易計畫載入失敗，這不代表沒有計畫。請確認資料庫更新與連線狀態。
          </p>
        ) : active.length ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {active.map((p) => (
              <PlanItem key={p.id} plan={p} today={today} />
            ))}
          </div>
        ) : (
          <p className="rounded-2xl border border-dashed border-line-strong p-6 text-sm text-slate-400">
            尚無有效計畫。從候選卡片展開「查看依據與建立計畫」開始。
          </p>
        )}
        {past.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm text-slate-400">
              已成交、到期與取消的計畫（{past.length}）
            </summary>
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              {past.map((p) => (
                <PlanItem key={p.id} plan={p} today={today} />
              ))}
            </div>
          </details>
        )}
      </section>
      <Suspense fallback={<div className="rounded-2xl border border-line p-5 text-sm text-slate-400" role="status">策略觀察統計載入中…</div>}>
        <ObservationSummary />
      </Suspense>
    </div>
  );
}
