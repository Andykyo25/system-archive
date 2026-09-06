"use client";

import { useActionState, useState } from "react";
import { cancelPlan, recordPlanFill, savePlan } from "./actions";
import type { ScanRow } from "@/lib/scan";
import type { ActionResult, TradePlan } from "@/lib/trade-plan";
import {
  estimateRisk,
  type RiskContext,
  type RiskEstimate,
} from "@/lib/plan-risk";

const input =
  "mt-1 w-full rounded-lg border border-line-strong bg-surface-sunken px-3 py-2.5 text-sm text-slate-100";
const button =
  "rounded-xl bg-sky-400 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-sky-300 disabled:opacity-50";

function Result({ state }: { state: ActionResult }) {
  return (
    <p
      aria-live="polite"
      className={`text-sm ${state.error ? "text-rose-300" : "text-emerald-300"}`}
    >
      {state.error ?? state.success}
    </p>
  );
}

export function PlanForm({
  row,
  today,
  riskContext,
}: {
  row: ScanRow;
  today: string;
  riskContext: RiskContext | null;
}) {
  const [state, action, pending] = useActionState(savePlan, {});
  const [withRisk, setWithRisk] = useState(false);
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [positionPct, setPositionPct] = useState("");
  const [industryPct, setIndustryPct] = useState("");
  const [slippagePct, setSlippagePct] = useState("");
  let risk: RiskEstimate | null = null;
  let riskError = "填寫買入上限、停損與三項風險假設後顯示估算。";
  if (
    riskContext &&
    [entry, stop, positionPct, industryPct, slippagePct].every((v) => v !== "")
  ) {
    try {
      risk = estimateRisk(
        riskContext,
        {
          symbol: row.symbol,
          industry: row.industry_category,
          entry: Number(entry),
          stop: Number(stop),
          positionPct: Number(positionPct),
          industryPct: Number(industryPct),
          slippagePct: Number(slippagePct),
        },
        today,
      );
    } catch (e) {
      riskError = e instanceof Error ? e.message : "無法估算";
    }
  }
  return (
    <form action={action} className="mt-4 space-y-4 border-t border-line pt-4">
      <input type="hidden" name="symbol" value={row.symbol} />
      <input type="hidden" name="signal_date" value={row.trade_date} />
      <p className="text-sm text-slate-300">
        先寫好價格與退出條件。保存時會一併凍結掃描依據；這裡不會送出委託。
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <label className="text-xs text-slate-400">
          買入下限
          <input
            className={input}
            name="entry_min"
            type="number"
            min="0.01"
            step="0.01"
            required
          />
        </label>
        <label className="text-xs text-slate-400">
          買入上限
          <input
            className={input}
            name="entry_max"
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            type="number"
            min="0.01"
            step="0.01"
            required
          />
        </label>
        <label className="text-xs text-slate-400">
          初始停損
          <input
            className={input}
            name="stop_price"
            value={stop}
            onChange={(e) => setStop(e.target.value)}
            type="number"
            min="0.01"
            step="0.01"
            required
          />
        </label>
        <label className="text-xs text-slate-400">
          有效至
          <input
            className={input}
            name="valid_until"
            type="date"
            min={today}
            required
          />
        </label>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="text-xs text-slate-400">
          進場依據與觸發條件
          <textarea
            className={input}
            name="entry_reason"
            minLength={5}
            maxLength={1000}
            rows={2}
            placeholder="例如：突破後回測支撐，且在買入區間內才考慮進場"
            required
          />
        </label>
        <label className="text-xs text-slate-400">
          出場規則與失效條件
          <textarea
            className={input}
            name="exit_rule"
            minLength={5}
            maxLength={1000}
            rows={2}
            placeholder="寫明停損採盤中觸價或收盤確認，以及多久未推進就退出"
            required
          />
        </label>
      </div>
      <div className="rounded-xl border border-line bg-surface-sunken p-3">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            name="include_risk"
            type="checkbox"
            checked={withRisk}
            disabled={!riskContext}
            onChange={(e) => setWithRisk(e.target.checked)}
          />
          一併估算可投入股數
        </label>
        {!riskContext && (
          <p className="mt-2 text-xs text-slate-400">
            帳戶估值暫時無法取得，仍可保存價格與退出計畫。
          </p>
        )}
        {withRisk && (
          <>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <label className="text-xs text-slate-400">
                單股上限 %
                <input
                  className={input}
                  name="position_pct"
                  type="number"
                  min="0.1"
                  max="100"
                  step="0.1"
                  value={positionPct}
                  onChange={(e) => setPositionPct(e.target.value)}
                  required
                />
              </label>
              <label className="text-xs text-slate-400">
                產業上限 %
                <input
                  className={input}
                  name="industry_pct"
                  type="number"
                  min="0.1"
                  max="100"
                  step="0.1"
                  value={industryPct}
                  onChange={(e) => setIndustryPct(e.target.value)}
                  required
                />
              </label>
              <label className="text-xs text-slate-400">
                單邊滑價 %
                <input
                  className={input}
                  name="slippage_pct"
                  type="number"
                  min="0"
                  max="10"
                  step="0.01"
                  value={slippagePct}
                  onChange={(e) => setSlippagePct(e.target.value)}
                  required
                />
              </label>
            </div>
            <div aria-live="polite" className="mt-3">
              {risk ? (
                <>
                  <p className="text-lg font-semibold text-sky-200">
                    估算上限 {risk.shares.toLocaleString()} 股
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    限制來自：{risk.limitingFactors.join("、")}
                    。依買入上限估算需現金{" "}
                    {Math.ceil(risk.cashRequired).toLocaleString()}{" "}
                    元，停損損失約{" "}
                    {Math.ceil(risk.estimatedLoss).toLocaleString()} 元。
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    {risk.caps.map((c) => (
                      <div key={c.label}>
                        <dt className="text-slate-500">{c.label}</dt>
                        <dd className="text-slate-300">
                          {c.shares.toLocaleString()} 股
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                <p className="text-xs text-amber-300">{riskError}</p>
              )}
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-500">
              風險比例沿用設定；估值日 {riskContext?.price_date ?? "—"}
              。已計手續費、稅與你填寫的滑價。此估算不預留現金，跳空或無法成交時損失可能更大；保存時重新取得帳戶資料。
            </p>
          </>
        )}
      </div>
      <Result state={state} />
      <button className={button} disabled={pending || !!state.success}>
        {pending ? "保存中…" : state.success ? "已保存" : "保存交易計畫"}
      </button>
    </form>
  );
}

export function PlanItem({ plan, today }: { plan: TradePlan; today: string }) {
  const [cancelState, cancelAction, cancelling] = useActionState(
    cancelPlan,
    {},
  );
  const [fillState, fillAction, filling] = useActionState(recordPlanFill, {});
  const expired = plan.valid_until < today;
  const watching = plan.status === "watching";
  const label =
    plan.status === "entered"
      ? "已記錄買入"
      : plan.status === "cancelled"
        ? "已取消"
        : expired
          ? "已到期"
          : "等待人工確認";
  return (
    <article className="rounded-2xl border border-line bg-surface-1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          {plan.symbol} {plan.signal_snapshot.name}
        </h3>
        <span
          className={`rounded-full px-2.5 py-1 text-xs ${watching && !expired ? "bg-sky-400/10 text-sky-200" : "bg-white/5 text-slate-400"}`}
        >
          {label}
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-slate-400">買入區間</dt>
          <dd className="mt-1">
            {plan.entry_min}–{plan.entry_max}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-400">初始停損</dt>
          <dd className="mt-1 text-rose-300">{plan.stop_price}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-400">有效期限</dt>
          <dd className="mt-1">{plan.valid_until}</dd>
        </div>
      </dl>
      <p className="mt-3 whitespace-pre-wrap text-sm text-slate-300">
        <span className="text-slate-500">進場：</span>
        {plan.entry_reason}
      </p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">
        <span className="text-slate-500">退出：</span>
        {plan.exit_rule}
      </p>
      <p className="mt-3 text-xs text-slate-500">
        訊號 {plan.signal_date} · 當時 {plan.signal_snapshot.score_total ?? "—"}{" "}
        分 · 原始計畫不隨現價改寫
      </p>
      {plan.risk_snapshot && (
        <p className="mt-3 rounded-lg bg-sky-400/5 p-3 text-xs leading-5 text-slate-300">
          建立時估算上限 {plan.risk_snapshot.shares.toLocaleString()} 股 ·
          預估停損損失{" "}
          {Math.ceil(plan.risk_snapshot.estimatedLoss).toLocaleString()} 元 ·
          限制來自 {plan.risk_snapshot.limitingFactors.join("、")}
          。這是當時帳戶快照，未預留資金。
        </p>
      )}
      {plan.holdings_transactions?.map((fill, i) => (
        <p
          key={i}
          className="mt-3 rounded-lg bg-white/5 p-3 text-sm text-slate-300"
        >
          實際成交：{fill.txn_date} · {fill.qty.toLocaleString()} 股 ×{" "}
          {fill.price}
          <span
            className={`mt-1 block text-xs ${Number(fill.price) >= Number(plan.entry_min) && Number(fill.price) <= Number(plan.entry_max) && fill.txn_date <= plan.valid_until ? "text-emerald-300" : "text-amber-300"}`}
          >
            {Number(fill.price) >= Number(plan.entry_min) &&
            Number(fill.price) <= Number(plan.entry_max)
              ? "成交在價格區間內"
              : "成交偏離價格區間"}{" "}
            ·{" "}
            {fill.txn_date <= plan.valid_until
              ? "在有效期內"
              : "成交已超過期限"}
          </span>
          {plan.risk_snapshot && Number(fill.qty) > plan.risk_snapshot.shares && <span className="mt-1 block text-xs text-amber-300">成交股數超過建立時估算上限（{plan.risk_snapshot.shares.toLocaleString()} 股）</span>}
        </p>
      ))}
      {watching && (
        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-sm text-sky-300">
            記錄實際買入
          </summary>
          <form action={fillAction} className="mt-3 space-y-3">
            <p className="text-xs leading-relaxed text-slate-400">
              僅記錄已成交交易，不會下單。即使成交偏離區間或期限，仍保留供事後檢討。
            </p>
            <input type="hidden" name="plan_id" value={plan.id} />
            <input type="hidden" name="symbol" value={plan.symbol} />
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-400">
                股數
                <input
                  className={input}
                  name="qty"
                  type="number"
                  min="1"
                  step="1"
                  required
                />
              </label>
              <label className="text-xs text-slate-400">
                成交價
                <input
                  className={input}
                  name="price"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                />
              </label>
              <label className="text-xs text-slate-400">
                成交日
                <input
                  className={input}
                  name="txn_date"
                  type="date"
                  min={plan.signal_date}
                  max={today}
                  defaultValue={today}
                  required
                />
              </label>
              <label className="text-xs text-slate-400">
                成交備註
                <input className={input} name="note" maxLength={1000} />
              </label>
            </div>
            <Result state={fillState} />
            <button
              className={button}
              disabled={filling || !!fillState.success}
            >
              {filling ? "記錄中…" : "確認記錄成交"}
            </button>
          </form>
        </details>
      )}
      {watching && (
        <form action={cancelAction} className="mt-3">
          <input type="hidden" name="id" value={plan.id} />
          <button
            disabled={cancelling}
            className="text-xs text-slate-400 underline underline-offset-4"
          >
            取消這份計畫
          </button>
          <Result state={cancelState} />
        </form>
      )}
    </article>
  );
}
