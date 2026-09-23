import Link from "next/link";
import { unstable_cache } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { readAll, unwrap } from "@/lib/db";
import type { VerdictRow } from "@/lib/scan";
import { taipeiDate, type TradePlan } from "@/lib/trade-plan";
import { VerdictBoard } from "./VerdictBoard";
import { PlanItem, type PlanSettings } from "./PlanForms";
import type { RiskContext } from "@/lib/plan-risk";

export const dynamic = "force-dynamic";

// v_scan_verdict 已完成所有判讀(型態 × 成績單勝率 × 信心門檻),頁面只負責呈現。
// Plans, settings and account risk stay fresh.
const loadVerdict = unstable_cache(async () => {
  const sb = createClient();
  const result = await readAll<VerdictRow>((from, to) => sb
    .from("v_scan_verdict").select("*")
    .order("up10_pct", { ascending: false }).order("day_pct", { ascending: false })
    .order("symbol").range(from, to));
  return unwrap(result, "今日看多") ?? [];
}, ["scan:verdict:v1"], { revalidate: 60 });

export default async function ScanPage() {
  const sb = createClient();
  const [rows, dateR, plansR, riskR, settingsR] =
    await Promise.all([
      loadVerdict(),
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
  const date = unwrap(dateR, "價格資料日")?.[0]?.trade_date ?? null;
  const today = taipeiDate();
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
    atrStopMultiple: setting("atr_stop_multiple"),
    slippagePct: setting("plan_slippage_pct"),
  };
  const cash = riskContext?.cash == null ? null : Number(riskContext.cash);
  return (
    <div className="space-y-6">
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
      {cash != null && cash <= 0 && (
        <p className="rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          資金已全數投入，新計畫股數會是 0。
        </p>
      )}
      <VerdictBoard
        rows={rows}
        today={today}
        plansAvailable={!plansR.error}
        riskContext={riskContext}
        settings={planSettings}
      />
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
