"use client";

import { useState, useTransition } from "react";
import {
  addBuyTransaction,
  checkBuyContext,
  type BuyContext,
  type BuySizing,
} from "./actions";
import { concentrationClass, EVENT_LABEL, fmtMoney } from "../_components/Format";

// 買入表單 + 進場脈絡警示(A 工程 2026-07-03)
// 股號輸入 blur → checkBuyContext → 追高/回追/盲區警示。不擋單,只強制看見。
// 實證動機:7/01-7/02 兩筆虧損(2408 回追、3236 盲區追高)當時資訊都在系統裡,
// 但沒出現在下單記錄路徑上。

const inputCls =
  "rounded-xl border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none";
const btnCls =
  "rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700";

export function BuyForm() {
  const [ctx, setCtx] = useState<BuyContext | null>(null);
  const [checking, startCheck] = useTransition();

  function onSymbolBlur(e: React.FocusEvent<HTMLInputElement>) {
    const symbol = e.target.value.trim();
    if (!symbol) {
      setCtx(null);
      return;
    }
    startCheck(async () => {
      setCtx(await checkBuyContext(symbol));
    });
  }

  return (
    <div>
      <form
        action={addBuyTransaction}
        className="grid grid-cols-1 gap-3 md:grid-cols-6"
      >
        <input
          name="symbol"
          placeholder="股號 (e.g. 2330)"
          required
          className={inputCls}
          onBlur={onSymbolBlur}
        />
        <input
          name="qty"
          type="number"
          min="1"
          placeholder="股數"
          required
          className={inputCls}
        />
        <input
          name="price"
          type="number"
          step="0.01"
          placeholder="買入價"
          required
          className={inputCls}
        />
        <input
          name="txn_date"
          type="date"
          defaultValue={new Date().toISOString().slice(0, 10)}
          required
          className={inputCls}
        />
        <input name="note" placeholder="備註 (選填)" className={inputCls} />
        <button className={btnCls}>新增</button>
      </form>
      {checking && (
        <p className="mt-2 text-xs text-zinc-500">查詢進場脈絡…</p>
      )}
      {!checking && ctx && <ContextPanel ctx={ctx} />}
    </div>
  );
}

// Regime 分區(同 dashboard U 型濾網口徑;僅 12 季樣本,paper-track 驗真中)
function regimeZoneLabel(ret: number): { label: string; minefield: boolean } {
  if (ret < 0) return { label: "歷史有利區(跌勢)", minefield: false };
  if (ret < 10) return { label: "中性區", minefield: false };
  if (ret < 20) return { label: "策略地雷區", minefield: true };
  return { label: "歷史有利區(強漲)", minefield: false };
}

function fmtBand(b: [number, number] | null): string {
  if (!b) return "—";
  return b[0] === b[1] ? `+${b[0].toFixed(1)}%` : `+${b[0].toFixed(1)}~${b[1].toFixed(1)}%`;
}

function ContextPanel({ ctx }: { ctx: BuyContext }) {
  // 回追:近 10 日賣過同檔,且現價高於賣價(= 用更高的價格買回)
  const isReentry =
    ctx.recentSell != null &&
    ctx.currentPrice != null &&
    ctx.currentPrice > ctx.recentSell.price;

  const boxes: React.ReactNode[] = [];
  const rz = ctx.regimeRet != null ? regimeZoneLabel(ctx.regimeRet) : null;

  if (!ctx.covered) {
    boxes.push(
      <WarnBox key="blind" tone="zinc">
        ❓ <b>{ctx.symbol} 不在追蹤池</b>(universe / industry / watchlist 皆無)
        — 系統無價位區 / 因子 / 排名資料,這是盲區單。3236(7/02 −6.9%)即此型態。
      </WarnBox>,
    );
  } else if (ctx.zone === "chase") {
    boxes.push(
      // regime 條件化(2026-07-11 Gate-0 實證):追高在 U 型地雷區升級紅色(12 季樣本);
      // 勝敗 regime 區間動態自 v_trade_behavior v3 聚合,不寫死會 stale 的敘事。
      <WarnBox key="chase" tone={rz?.minefield ? "red" : "amber"}>
        ⚠ <b>追高區</b>:偏離 MA20{" "}
        <b>{ctx.devMa20 != null ? `+${ctx.devMa20.toFixed(1)}%` : "—"}</b>
        (門檻 +10%)
        {ctx.ret20d != null && <>,20 日已漲 {ctx.ret20d.toFixed(1)}%</>}。
        歷史波段追高買:{ctx.chaseWins} 勝 {ctx.chaseLosses} 敗;
        非追高買:{ctx.nonChaseWins} 勝 {ctx.nonChaseLosses} 敗 —{" "}
        <b>兩組沒有可辨識的差異</b>(2026-08-17 全量重算;樣本小,自動統計)。
        這個框是「讓你知道自己站在哪裡」,不是「這樣做比較差」。
        {(ctx.chaseWinRegimeBand || ctx.chaseLossRegimeBand) && (
          <>
            {" "}
            追高的勝發生在 0050 近季 {fmtBand(ctx.chaseWinRegimeBand)}、敗在{" "}
            {fmtBand(ctx.chaseLossRegimeBand)}。
          </>
        )}
        {ctx.regimeRet != null && rz && (
          <>
            {" "}
            此刻 0050 近季 <b>{ctx.regimeRet >= 0 ? "+" : ""}{ctx.regimeRet.toFixed(1)}%</b>
            ({rz.label})
            {rz.minefield && <b> — 地雷區訊號來自 12 季回測樣本,與上面的逐筆戰績是兩套證據</b>}。
          </>
        )}
      </WarnBox>,
    );
  } else if (ctx.zone === "pullback") {
    boxes.push(
      <WarnBox key="pb" tone="green">
        ✓ 回檔至支撐區(偏離 MA20{" "}
        {ctx.devMa20 != null ? `${ctx.devMa20 >= 0 ? "+" : ""}${ctx.devMa20.toFixed(1)}%` : "—"}
        )。歷史非追高買 {ctx.nonChaseWins} 勝 {ctx.nonChaseLosses} 敗,與追高組
        ({ctx.chaseWins} 勝 {ctx.chaseLosses} 敗)無可辨識差異 —
        買點位置本身不是你的勝負來源,仍需並看籌碼 / 訊號燈。
      </WarnBox>,
    );
  } else if (ctx.zone === "broken") {
    boxes.push(
      <WarnBox key="bk" tone="sky">
        🧊 趨勢破壞區(跌破 MA60 且距高 &gt;25%)— 別接刀。
      </WarnBox>,
    );
  }

  if (isReentry && ctx.recentSell) {
    boxes.push(
      <WarnBox key="re" tone="red">
        🔁 <b>賣飛回追警示</b>:{ctx.recentSell.date} 曾於{" "}
        {ctx.recentSell.price.toLocaleString()} 賣出,現價{" "}
        {ctx.currentPrice?.toLocaleString()} 更高。歷史回追:
        {ctx.reentryWins} 勝 {ctx.reentryLosses} 敗(2408 6/25 −8.2%、8/10 +6.6%,
        樣本 n=2 不足以下結論)。真正確定的是:用更高的價買回 = 上一次停利出早了。
      </WarnBox>,
    );
  }

  if (ctx.upcomingEvents.length > 0) {
    boxes.push(
      <WarnBox key="ev" tone="amber">
        📅 <b>事件風險</b>:
        {ctx.upcomingEvents
          .map((e) => `${EVENT_LABEL[e.type] ?? e.type} ${e.date.slice(5)}`)
          .join("、")}
        (14 日內)— 事件前進場 = 對結果下注,想清楚再進。
      </WarnBox>,
    );
  }

  if (ctx.sizing) {
    boxes.push(<SizingBox key="sz" z={ctx.sizing} />);
  }

  if (boxes.length === 0) return null;
  return <div className="mt-2 space-y-2">{boxes}</div>;
}

// ATR 部位管理(規畫② 2026-07-10):建議張數 + 集中度,只呈現不擋單。
function SizingBox({ z }: { z: BuySizing }) {
  const lotRiskPct = (z.lotRisk / z.capital) * 100;
  const lotValuePct = z.lotValue != null ? (z.lotValue / z.capital) * 100 : null;
  const existingPct = (z.existingValue / z.capital) * 100;
  const afterPct =
    lotValuePct != null ? ((z.existingValue + (z.lotValue ?? 0)) / z.capital) * 100 : null;
  const overBudget = z.suggestedLots === 0;
  return (
    <div className="rounded border border-line bg-surface-1 px-3 py-2 text-xs leading-relaxed text-zinc-300">
      <p>
        📐 <b>部位管理</b>:ATR14 {z.atr14.toFixed(1)}({z.atrPct.toFixed(1)}%)
        · 停損距 {z.kMultiple}×ATR = {z.stopDistance.toFixed(1)} · 風險預算{" "}
        {fmtMoney(z.riskBudget, 0)}(資本 {fmtMoney(z.capital, 0)} ×{" "}
        {(z.riskPct * 100).toFixed(1)}%)
      </p>
      <p className={overBudget ? "text-red-300" : ""}>
        {overBudget ? (
          <>
            ⚠ <b>此波動下 1 張已超出風險預算</b> — 1 張停損風險{" "}
            {fmtMoney(z.lotRisk, 0)} ≈ 資本{" "}
            <b>{lotRiskPct.toFixed(1)}%</b>(預算的{" "}
            {(z.lotRisk / z.riskBudget).toFixed(1)} 倍)。要進場 = 有意識接受超額風險。
          </>
        ) : (
          <>
            建議 ≤ <b>{z.suggestedLots} 張</b>(1 張停損風險 {fmtMoney(z.lotRisk, 0)} ≈
            資本 {lotRiskPct.toFixed(1)}%)
          </>
        )}
      </p>
      {lotValuePct != null && (
        <p>
          集中度:1 張市值 {fmtMoney(z.lotValue, 0)} ={" "}
          <span className={concentrationClass(lotValuePct)}>
            資本 {lotValuePct.toFixed(0)}%
          </span>
          {z.existingValue > 0 && (
            <>
              ;已持有 {fmtMoney(z.existingValue, 0)}(
              <span className={concentrationClass(existingPct)}>
                {existingPct.toFixed(0)}%
              </span>
              ),買 1 張後{" "}
              <span className={concentrationClass(afterPct)}>
                {afterPct != null ? afterPct.toFixed(0) : "—"}%
              </span>
            </>
          )}
          <span className="text-zinc-500">(&gt;30% 黃 / &gt;60% 橘 / &gt;100% 紅)</span>
        </p>
      )}
    </div>
  );
}

const TONE_CLS: Record<string, string> = {
  amber: "border-amber-900/50 bg-amber-950/25 text-amber-200/90",
  red: "border-red-900/50 bg-red-950/25 text-red-200/90",
  green: "border-green-900/50 bg-green-950/20 text-green-200/90",
  sky: "border-sky-900/50 bg-sky-950/20 text-sky-200/90",
  zinc: "border-zinc-700/60 bg-surface-1 text-zinc-300",
};

function WarnBox({
  tone,
  children,
}: {
  tone: keyof typeof TONE_CLS;
  children: React.ReactNode;
}) {
  return (
    <p className={`rounded border px-3 py-2 text-xs leading-relaxed ${TONE_CLS[tone]}`}>
      {children}
    </p>
  );
}
