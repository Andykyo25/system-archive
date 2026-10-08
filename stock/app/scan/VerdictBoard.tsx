import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  VERDICT_EXIT,
  conditions,
  verdictEvidence,
  type VerdictLive,
  type VerdictRow,
} from "@/lib/scan";
import { planDefaults } from "@/lib/plan-defaults";
import { fmtMoney, fmtPct, pctColor } from "@/app/_components/Format";
import type { RiskContext } from "@/lib/plan-risk";
import { PlanForm, type PlanSettings } from "./PlanForms";
import { quoteStatus, type EvidenceDates, type HoldingEvidence } from "@/lib/holding-decision";

const BADGE = {
  ok: "bg-rose-400/10 text-rose-300 ring-rose-300/20",
  wait: "bg-rose-400/10 text-rose-300 ring-rose-300/20",
  block: "bg-slate-400/10 text-slate-300 ring-slate-300/20",
} as const;

// 系統結論卡:只呈現「看多 + 依據一句 + 怎麼做」,判讀都在 v_scan_verdict(R2p)算完;
// 盤中狀態來自 v_verdict_live(每次載入即時計算;只看今日是否曾跌破停損,套牢量於上榜時已判定)。
export function VerdictBoard({
  rows,
  live,
  today,
  plansAvailable,
  riskContext,
  settings,
  factors = {}, dates = {}, evidenceError, liveAvailable = true, quoteSources = {},
}: {
  rows: VerdictRow[];
  live: Map<string, VerdictLive>;
  today: string;
  plansAvailable: boolean;
  riskContext: RiskContext | null;
  settings: PlanSettings;
  factors?: Record<string,HoldingEvidence>;
  dates?: Record<string,EvidenceDates>;
  evidenceError?: string | null;
  liveAvailable?: boolean;
  quoteSources?: Record<string,string | null>;
}) {
  if (!rows.length) {
    return (
      <p className="rounded-2xl border border-dashed border-line-strong p-10 text-center text-slate-300">
        今日沒有看多標的
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
          ma20Stop: false,
          exit: VERDICT_EXIT,
        });
        const close = Number(r.close);
        const stopPct = plan && close > 0 ? (plan.stopPrice / close - 1) * 100 : null;
        const lv = live.get(r.symbol);
        const state = lv?.state ?? "wait";
        const quality = lv?.quoted_at ? quoteStatus(lv.quoted_at,quoteSources[r.symbol]??null) : null;
        const confirmed = liveAvailable && quality?.reliable && quality.label === '盤中報價';
        const badge = !liveAvailable ? '盤中檢查失敗' : state === "block" ? "停止進場" : state === "ok" && confirmed ? "型態符合 · 核對進場" : "盤後候選 · 待確認";
        const factor=factors[r.symbol], ds=dates[r.symbol];
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
              <span className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${BADGE[state]}`}>
                {badge}
              </span>
            </div>
            <div className="mt-3 flex items-baseline gap-3">
              <span className="text-2xl font-medium">{fmtMoney(r.close, 2)}</span>
              <span className={`text-sm ${pctColor(r.day_pct)}`}>{fmtPct(r.day_pct)}</span>
              {lv?.price_now != null && (
                <span className="ml-auto text-xs text-slate-400">
                  現價 {fmtMoney(lv.price_now, 2)}
                </span>
              )}
            </div>
            <p className="mt-2 text-sm text-slate-300">
              貼近 60 日高（{Number(r.off_hi60).toFixed(1)}%）
              {r.supply_share != null &&
                ` · 上方套牢 ${(Number(r.supply_share) * 100).toFixed(0)}%`}
            </p>
            {state === "block" && (
              <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-sm text-amber-200">
                ⛔ {lv?.reason}，不要進場
              </p>
            )}
            {!liveAvailable && <p role="alert" className="mt-3 text-sm text-amber-200">盤中風險檢查載入失敗，請重新確認後再評估進場。</p>}
            <p className="mt-2 text-xs text-slate-400">{quality?.label??'今日報價未取得'} · {lv?.quoted_at ? new Date(lv.quoted_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '時間未確認'} 台北 · {quoteSources[r.symbol]??'來源未確認'}</p>
            {evidenceError ? <p role="alert" className="mt-3 text-sm text-amber-200">{evidenceError}</p> : <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3 text-xs">
              {[
                {name:'基本面',pos:factor?.fund_count_pos,total:factor?.fund_count_total,date:ds?.fundamental},
                {name:'技術面',pos:factor?.mom_count_pos,total:factor?.mom_count_total,date:ds?.technical??r.trade_date},
                {name:'籌碼面',pos:factor?.chip_count_pos,total:factor?.chip_count_total,date:ds?.chip},
              ].map(d=><div key={d.name} className="min-w-0"><dt className="text-slate-400">{d.name}</dt><dd className="mt-1">{d.total && d.pos!=null?`${d.pos}/${d.total} 通過`:'因子不足'}</dd><dd className="mt-1 break-words text-slate-400">{d.date??'資料日未確認'}</dd></div>)}
            </dl>}
            <p className="mt-3 text-xs leading-relaxed text-slate-400">R2p 依價量型態選出；三面因子供研究，缺資料時無法認定綜合看多。</p>
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
                  <dt className="text-xs text-slate-500">出場</dt>
                  <dd className="mt-1">
                    +{VERDICT_EXIT.takeProfitPct}% 或 {VERDICT_EXIT.maxHoldDays} 日
                  </dd>
                </div>
              </dl>
            )}
            {plansAvailable && state !== "block" && liveAvailable && (
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
