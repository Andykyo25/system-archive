"use client";

import { useActionState, useState } from "react";
import { cancelPlan, recordPlanFill, savePlan } from "./actions";
import { conditions, type ScanRow } from "@/lib/scan";
import type { ActionResult, TradePlan } from "@/lib/trade-plan";
import { planDefaults } from "@/lib/plan-defaults";
import {
  estimateRisk,
  type RiskContext,
  type RiskEstimate,
} from "@/lib/plan-risk";

export interface PlanSettings {
  atrStopMultiple: number | null;
  slippagePct: number | null;
}

const input =
  "mt-1 w-full rounded-lg border border-line-strong bg-surface-sunken px-3 py-2.5 text-sm text-slate-100";
const button =
  "rounded-xl bg-sky-400 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-sky-300 disabled:opacity-50";
const hint = "mt-1 block text-[11px] leading-4 text-slate-500";

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
  settings,
}: {
  row: ScanRow;
  today: string;
  riskContext: RiskContext | null;
  settings: PlanSettings;
}) {
  const [state, action, pending] = useActionState(savePlan, {});
  const suggested = planDefaults(row, {
    today,
    atrStopMultiple: settings.atrStopMultiple,
    checks: conditions(row),
  });
  const defaultSlippage = String(settings.slippagePct ?? 0.3);
  // Prefilled from the signal row and existing settings; every field stays editable.
  const [entryMin, setEntryMin] = useState(
    suggested ? suggested.entryMin.toFixed(2) : "",
  );
  const [entryMax, setEntryMax] = useState(
    suggested ? suggested.entryMax.toFixed(2) : "",
  );
  const [stop, setStop] = useState(
    suggested ? suggested.stopPrice.toFixed(2) : "",
  );
  const [validUntil, setValidUntil] = useState(suggested?.validUntil ?? "");
  const [entryReason, setEntryReason] = useState(suggested?.entryReason ?? "");
  const [exitRule, setExitRule] = useState(suggested?.exitRule ?? "");
  const [slippagePct, setSlippagePct] = useState(defaultSlippage);
  const [withRisk, setWithRisk] = useState(!!riskContext);
  const [edited, setEdited] = useState(false);

  const reset = () => {
    if (!suggested) return;
    setEntryMin(suggested.entryMin.toFixed(2));
    setEntryMax(suggested.entryMax.toFixed(2));
    setStop(suggested.stopPrice.toFixed(2));
    setValidUntil(suggested.validUntil);
    setEntryReason(suggested.entryReason);
    setExitRule(suggested.exitRule);
    setSlippagePct(defaultSlippage);
    setEdited(false);
  };
  // Marks the form as touched so "還原建議值" only appears once it is useful.
  const track = (set: (v: string) => void) => (v: string) => {
    setEdited(true);
    set(v);
  };

  let risk: RiskEstimate | null = null;
  let riskError = "填寫買入上限、停損與滑價後顯示估算。";
  if (riskContext && [entryMax, stop, slippagePct].every((v) => v !== "")) {
    try {
      risk = estimateRisk(
        riskContext,
        {
          symbol: row.symbol,
          industry: row.industry_category,
          entry: Number(entryMax),
          stop: Number(stop),
          slippagePct: Number(slippagePct),
        },
        today,
      );
    } catch (e) {
      riskError = e instanceof Error ? e.message : "無法估算";
    }
  }
  const equity = Number(riskContext?.equity ?? 0);
  const sameIndustry =
    riskContext && row.industry_category && equity > 0
      ? (riskContext.positions
          .filter((p) => p.industry === row.industry_category)
          .reduce((a, p) => a + Number(p.market_value ?? 0), 0) /
          equity) *
        100
      : null;

  return (
    <form action={action} className="mt-4 space-y-4 border-t border-line pt-4">
      <input type="hidden" name="symbol" value={row.symbol} />
      <input type="hidden" name="signal_date" value={row.trade_date} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-300">
          {suggested
            ? "已依訊號資料與你的設定自動帶入，確認或修改後再保存。這裡不會送出委託。"
            : "此標的缺少價格資料，無法自動帶入，請自行填寫。"}
        </p>
        {suggested && edited && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-sky-300 underline underline-offset-4"
          >
            還原建議值
          </button>
        )}
      </div>
      {suggested?.notes.map((n) => (
        <p
          key={n}
          className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-2.5 text-xs leading-5 text-amber-200"
        >
          {n}
        </p>
      ))}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <label className="text-xs text-slate-400">
          買入下限
          <input
            className={input}
            name="entry_min"
            value={entryMin}
            onChange={(e) => track(setEntryMin)(e.target.value)}
            type="number"
            min="0.01"
            step="0.01"
            required
          />
          <span className={hint}>訊號收盤 −3%</span>
        </label>
        <label className="text-xs text-slate-400">
          買入上限
          <input
            className={input}
            name="entry_max"
            value={entryMax}
            onChange={(e) => track(setEntryMax)(e.target.value)}
            type="number"
            min="0.01"
            step="0.01"
            required
          />
          <span className={hint}>收盤 +3%，且不超過月線 +15%</span>
        </label>
        <label className="text-xs text-slate-400">
          初始停損
          <input
            className={input}
            name="stop_price"
            value={stop}
            onChange={(e) => track(setStop)(e.target.value)}
            type="number"
            min="0.01"
            step="0.01"
            required
          />
          <span className={hint}>
            {suggested ? suggested.stopBasis : "須低於買入下限"}
          </span>
        </label>
        <label className="text-xs text-slate-400">
          有效至
          <input
            className={input}
            name="valid_until"
            value={validUntil}
            onChange={(e) => track(setValidUntil)(e.target.value)}
            type="date"
            min={today}
            required
          />
          <span className={hint}>約 10 個交易日</span>
        </label>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="text-xs text-slate-400">
          進場依據與觸發條件
          <textarea
            className={input}
            name="entry_reason"
            value={entryReason}
            onChange={(e) => track(setEntryReason)(e.target.value)}
            minLength={5}
            maxLength={1000}
            rows={5}
            required
          />
        </label>
        <label className="text-xs text-slate-400">
          出場規則與失效條件
          <textarea
            className={input}
            name="exit_rule"
            value={exitRule}
            onChange={(e) => track(setExitRule)(e.target.value)}
            minLength={5}
            maxLength={1000}
            rows={5}
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
          一併保存股數估算
        </label>
        {!riskContext && (
          <p className="mt-2 text-xs text-slate-400">
            帳戶估值暫時無法取得，仍可保存價格與退出計畫。
          </p>
        )}
        {withRisk && (
          <>
            <div aria-live="polite" className="mt-3">
              {risk ? (
                <>
                  <p
                    className={`text-lg font-semibold ${risk.shares > 0 ? "text-sky-200" : "text-amber-200"}`}
                  >
                    估算上限 {risk.shares.toLocaleString()} 股
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {risk.shares > 0 ? (
                      <>
                        限制來自：{risk.limitingFactors.join("、")}
                        。依買入上限估算需現金{" "}
                        {Math.ceil(risk.cashRequired).toLocaleString()}{" "}
                        元，觸及停損損失約{" "}
                        {Math.ceil(risk.estimatedLoss).toLocaleString()} 元。
                      </>
                    ) : (
                      <>
                        目前買不到：{risk.limitingFactors.join("、")}為 0。
                        可用現金{" "}
                        {(
                          Math.round(risk.inputs.cash * 100) / 100
                        ).toLocaleString()}{" "}
                        元，單筆風險預算{" "}
                        {Math.floor(risk.riskBudget).toLocaleString()}{" "}
                        元。要進場需先賣出部位或增加資金。
                      </>
                    )}
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    {risk.caps.map((c) => (
                      <div key={c.label}>
                        <dt className="text-slate-500">{c.label}</dt>
                        <dd
                          className={
                            c.shares === risk!.shares
                              ? "text-amber-200"
                              : "text-slate-300"
                          }
                        >
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
            <label className="mt-3 block text-xs text-slate-400 sm:w-40">
              單邊滑價 %
              <input
                className={input}
                name="slippage_pct"
                type="number"
                min="0"
                max="10"
                step="0.01"
                value={slippagePct}
                onChange={(e) => track(setSlippagePct)(e.target.value)}
                required
              />
              <span className={hint}>沿用設定 plan_slippage_pct</span>
            </label>
            <p className="mt-3 text-xs leading-5 text-slate-500">
              風險比例沿用設定 risk_pct_per_trade；估值日{" "}
              {riskContext?.price_date ?? "—"}。已計手續費、稅與滑價。
              未設集中度上限，估算只受單筆風險預算與可用現金限制
              {sameIndustry != null && sameIndustry > 0 && (
                <>
                  ；目前 {row.industry_category} 已佔帳戶{" "}
                  {sameIndustry.toFixed(0)}%，同產業加碼請自行斟酌
                </>
              )}
              。此估算不預留現金，跳空或無法成交時損失可能更大；保存時會重新取得帳戶資料再算一次。
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
