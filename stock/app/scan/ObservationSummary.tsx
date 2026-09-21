import { ShieldCheck } from "lucide-react";
import { unstable_cache } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { readAll, unwrap } from "@/lib/db";
import { summarizeObservations, type Observation } from "@/lib/scan";

const loadObservations = unstable_cache(async () => {
  const sb = createClient();
  const result = await readAll<Observation>((from, to) => sb
    .from("v_scan_track_v2")
    .select("scan_date,symbol,horizon,strategy_version,excess_pct,observation_status")
    .eq("horizon", 5).eq("strategy_version", "breakout-v3-adjusted")
    .order("scan_date").order("symbol").range(from, to));
  return summarizeObservations(unwrap(result, "前向追蹤") ?? []);
}, ["scan:observations:v1"], { revalidate: 300 });

export async function ObservationSummary() {
  let stats = null;
  try { stats = await loadObservations(); }
  catch (error) { console.error("[scan:observations]", error); }
  return (
      <section className="rounded-2xl border border-line bg-surface-1 p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck size={18} className="text-sky-300" aria-hidden />{" "}
          策略證據 · 持續觀察中
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          新版掃描單獨累積樣本。以隔一交易日收盤至五交易日後的還原報酬比較同日基準；未扣成本，尚非進出場策略績效。
        </p>
        {stats == null ? (
          <p role="alert" className="mt-4 text-sm text-amber-300">
            前向追蹤載入失敗，暫時無法評估。
          </p>
        ) : (
          <>
            <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                [
                  "日均超額",
                  stats.mean == null
                    ? "尚無結果"
                    : `${stats.mean >= 0 ? "+" : ""}${stats.mean.toFixed(2)} pp`,
                ],
                ["已觀察", `${stats.days} 日 / ${stats.settled} 筆`],
                ["尚未到期", `${stats.pending} 筆`],
                ["缺料或凍結過晚", `${stats.missing} 筆`],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-slate-400">{label}</dt>
                  <dd className="mt-2 text-lg font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-xs leading-5 text-slate-500">
              各掃描日先平均，再跨日平均。連續五日視窗仍有重疊，不能視為獨立樣本；基準缺料時不顯示超額，避免只計算有報價的股票。舊版凍結樣本未混入。
            </p>
          </>
        )}
      </section>
  );
}
