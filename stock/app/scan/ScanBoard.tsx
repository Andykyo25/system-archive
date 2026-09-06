"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Check,
  Minus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { conditions, type ScanRow } from "@/lib/scan";
import { fmtMoney, fmtPct, pctColor } from "@/app/_components/Format";
import { PlanForm } from "./PlanForms";
import type { RiskContext } from "@/lib/plan-risk";

export function ScanBoard({
  rows,
  today,
  plansAvailable,
  riskContext,
}: {
  rows: ScanRow[];
  today: string;
  plansAvailable: boolean;
  riskContext: RiskContext | null;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [industry, setIndustry] = useState("");
  const [sort, setSort] = useState("score");
  const industries = [
    ...new Set(
      rows.map((r) => r.industry_category).filter((s): s is string => !!s),
    ),
  ].sort();
  const visible = rows
    .filter(
      (r) =>
        `${r.symbol} ${r.name ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()) &&
        (!industry || r.industry_category === industry) &&
        (filter !== "strict" || r.passes_all === true) &&
        (filter !== "near" || r.passes_all !== true),
    )
    .sort(
      (a, b) =>
        (sort === "volume"
          ? (b.volume_lots ?? 0) - (a.volume_lots ?? 0)
          : (b.score_total ?? 0) - (a.score_total ?? 0)) ||
        a.symbol.localeCompare(b.symbol),
    );
  return (
    <section className="space-y-4" aria-label="起漲候選清單">
      <div className="rounded-2xl border border-line bg-surface-1 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-48 flex-1">
            <Search
              aria-hidden
              size={16}
              className="absolute left-3 top-3 text-slate-500"
            />
            <input
              aria-label="搜尋股號或名稱"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋股號或名稱"
              className="w-full rounded-xl border border-line-strong bg-surface-sunken py-2.5 pl-9 pr-3 text-sm"
            />
          </div>
          <select
            aria-label="產業篩選"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            className="rounded-xl border border-line-strong bg-surface-sunken p-2.5 text-sm"
          >
            <option value="">全部產業</option>
            {industries.map((i) => (
              <option key={i}>{i}</option>
            ))}
          </select>
          <select
            aria-label="候選排序"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="rounded-xl border border-line-strong bg-surface-sunken p-2.5 text-sm"
          >
            <option value="score">評分由高到低</option>
            <option value="volume">成交量由高到低</option>
          </select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SlidersHorizontal
            size={14}
            aria-hidden
            className="mr-1 text-slate-500"
          />
          {[
            ["all", "全部候選"],
            ["strict", "五條件全過"],
            ["near", "尚待確認"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`rounded-lg px-3 py-2 text-xs ${filter === value ? "bg-sky-400/15 text-sky-200 ring-1 ring-sky-400/25" : "text-slate-400 hover:bg-white/5"}`}
            >
              {label}
            </button>
          ))}
          <span aria-live="polite" className="ml-auto text-xs text-slate-400">
            顯示 {visible.length} / {rows.length} 檔
          </span>
        </div>
      </div>
      {!visible.length && (
        <div className="rounded-2xl border border-dashed border-line-strong p-10 text-center">
          <p className="text-slate-300">目前沒有符合條件的候選</p>
          <p className="mt-2 text-sm text-slate-500">
            可以調整篩選，或等待下一次資料更新。
          </p>
          <button
            onClick={() => {
              setQuery("");
              setFilter("all");
              setIndustry("");
            }}
            className="mt-4 text-sm text-sky-300"
          >
            清除篩選
          </button>
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {visible.map((r) => (
          <article
            key={r.symbol}
            className="rounded-2xl border border-line bg-surface-1 p-4 sm:p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs text-slate-400">
                  {r.industry_category ?? "產業未分類"}
                </p>
                <Link
                  href={`/stocks/${r.symbol}`}
                  className="mt-1 inline-flex items-center gap-2 text-lg font-semibold hover:text-sky-300"
                >
                  {r.name ?? r.symbol}
                  <span className="font-mono text-sm font-normal text-slate-500">
                    {r.symbol}
                  </span>
                  <ArrowUpRight size={16} aria-hidden />
                </Link>
              </div>
              <div className="text-right">
                <span className="text-2xl font-semibold text-slate-100">
                  {r.score_total ?? "—"}
                </span>
                <span className="ml-1 text-xs text-slate-500">/100</span>
                <p
                  className={`mt-1 text-xs ${r.passes_all ? "text-emerald-300" : "text-amber-300"}`}
                >
                  {r.passes_all ? "突破條件符合" : "尚待條件確認"}
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-2xl font-medium">
                {fmtMoney(r.close, 2)}
              </span>
              <span className={`text-sm ${pctColor(r.day_pct)}`}>
                {fmtPct(r.day_pct)}
              </span>
              <span className="ml-auto text-xs text-slate-400">
                {r.volume_lots?.toLocaleString() ?? "—"} 張
              </span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {[
                ["起漲", r.score_surge, 34],
                ["位置", r.score_position, 33],
                ["動能", r.score_momentum, 33],
              ].map(([label, score, max]) => (
                <div key={String(label)}>
                  <div className="mb-1.5 flex justify-between text-xs text-slate-400">
                    <span>{label}</span>
                    <span>
                      {score ?? "—"}/{max}
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-white/5">
                    <div
                      className="h-1 rounded-full bg-sky-400/70"
                      style={{
                        width: `${(Number(score ?? 0) / Number(max)) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {conditions(r).map((c) => (
                <span
                  key={c.label}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${c.pass ? "bg-emerald-400/8 text-emerald-200" : "bg-amber-400/8 text-amber-200"}`}
                >
                  {c.pass ? (
                    <Check size={12} aria-hidden />
                  ) : (
                    <Minus size={12} aria-hidden />
                  )}
                  {c.label}
                </span>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-400">
              外資近五交易日：
              {r.fgn_net_5d == null
                ? "資料未齊，不參與評分"
                : `${Math.round(r.fgn_net_5d / 1000).toLocaleString()} 張`}{" "}
              · 資料 {r.trade_date}
            </p>
            <details className="mt-4 border-t border-line pt-3">
              <summary className="cursor-pointer text-sm text-sky-300">
                查看依據與建立計畫
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-slate-400">
                前高 {fmtMoney(r.high_20d, 2)} · 月線 {fmtMoney(r.ma20, 2)} ·
                乖離 {fmtPct(r.ma20_gap_pct)}
                。分數描述型態符合程度，不代表上漲機率。請確認價格、停損與有效期限後再決定。
              </p>
              {plansAvailable ? (
                <PlanForm row={r} today={today} riskContext={riskContext} />
              ) : (
                <p className="mt-3 text-sm text-amber-300">
                  交易計畫暫時無法載入，請稍後重試。
                </p>
              )}
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}
