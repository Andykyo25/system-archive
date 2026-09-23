import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  PATTERN_LABEL,
  conditions,
  verdictEvidence,
  type VerdictRow,
} from "@/lib/scan";
import { planDefaults } from "@/lib/plan-defaults";
import { fmtMoney, fmtPct, pctColor } from "@/app/_components/Format";
import type { RiskContext } from "@/lib/plan-risk";
import { PlanForm, type PlanSettings } from "./PlanForms";

// 系統結論卡:只呈現「看多 + 信心 + 依據一句 + 怎麼做」,判讀都在 v_scan_verdict 算完。
export function VerdictBoard({
  rows,
  today,
  plansAvailable,
  riskContext,
  settings,
}: {
  rows: VerdictRow[];
  today: string;
  plansAvailable: boolean;
  riskContext: RiskContext | null;
  settings: PlanSettings;
}) {
  if (!rows.length) {
    return (
      <p className="rounded-2xl border border-dashed border-line-strong p-10 text-center text-slate-300">
        今日沒有中高信心標的
      </p>
    );
  }
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {rows.map((r) => {
        const evidence = verdictEvidence(r);
        const plan = planDefaults(r, {
          today,
          atrStopMultiple: settings.atrStopMultiple,
          checks: conditions(r),
          antiChase: false,
          evidence,
        });
        const close = Number(r.close);
        const stopPct = plan && close > 0 ? (plan.stopPrice / close - 1) * 100 : null;
        return (
          <article
            key={r.symbol}
            className="rounded-2xl border border-line bg-surface-1 p-4 sm:p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <Link
                href={`/stocks/${r.symbol}`}
                className="inline-flex items-center gap-2 text-lg font-semibold hover:text-sky-300"
              >
                {r.name ?? r.symbol}
                <span className="font-mono text-sm font-normal text-slate-500">
                  {r.symbol}
                </span>
                <ArrowUpRight size={16} aria-hidden />
              </Link>
              <span className="shrink-0 rounded-lg bg-rose-400/10 px-2.5 py-1 text-xs font-semibold text-rose-300 ring-1 ring-inset ring-rose-300/20">
                看多 · 信心{r.confidence}
              </span>
            </div>
            <div className="mt-3 flex items-baseline gap-3">
              <span className="text-2xl font-medium">{fmtMoney(r.close, 2)}</span>
              <span className={`text-sm ${pctColor(r.day_pct)}`}>{fmtPct(r.day_pct)}</span>
            </div>
            <p className="mt-2 text-sm text-slate-300">
              {PATTERN_LABEL[r.pattern]} · 同型態 10 日內上漲{" "}
              <span className="font-semibold text-slate-100">
                {Number(r.up10_pct).toFixed(0)}%
              </span>
            </p>
            {plan && (
              <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">買入</dt>
                  <dd className="mt-1 tabular-nums">
                    {plan.entryMin.toFixed(2)}–{plan.entryMax.toFixed(2)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">停損</dt>
                  <dd className="mt-1 tabular-nums">
                    {plan.stopPrice.toFixed(2)}
                    {stopPct != null && (
                      <span className="ml-1 text-xs text-slate-500">
                        {stopPct.toFixed(1)}%
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">持有</dt>
                  <dd className="mt-1">10 個交易日</dd>
                </div>
              </dl>
            )}
            {plansAvailable && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-sky-300">
                  建立交易計畫
                </summary>
                <PlanForm
                  row={r}
                  today={today}
                  riskContext={riskContext}
                  settings={settings}
                  evidence={evidence}
                />
              </details>
            )}
          </article>
        );
      })}
    </div>
  );
}
