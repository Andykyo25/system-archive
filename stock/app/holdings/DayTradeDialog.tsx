"use client";

import { useState, useTransition } from "react";
import { addDayTradeTransaction } from "./actions";

interface Props {
  feeRate: number;
  taxStock: number; // 當沖現股稅率(0.0015)
  taxEtf: number; // 當沖 ETF 稅率(0.0005)
}

function isEtf(symbol: string): boolean {
  return /^00\d+/.test(symbol);
}

// 當沖 dialog:輸入 股號 + 股數 + 買價 + 賣價 + 日期 → 預覽損益(買賣雙邊費 + 當沖稅)
// 不涉及持股移動平均(寫 day_trades 表),所以股號自由輸入、不檢查庫存。
export function DayTradeDialog({ feeRate, taxStock, taxEtf }: Props) {
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [qtyStr, setQtyStr] = useState("1000");
  const [buyStr, setBuyStr] = useState("");
  const [sellStr, setSellStr] = useState("");
  const [dateStr, setDateStr] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const qty = Number(qtyStr);
  const buy = Number(buyStr);
  const sell = Number(sellStr);
  const sym = symbol.trim();
  const symbolValid = sym.length > 0;
  const qtyValid = Number.isFinite(qty) && qty > 0;
  const buyValid = Number.isFinite(buy) && buy > 0;
  const sellValid = Number.isFinite(sell) && sell > 0;
  const valid = symbolValid && qtyValid && buyValid && sellValid;

  // 預覽(與 action 端一致:floor 到整數元)
  const taxRate = isEtf(sym) ? taxEtf : taxStock;
  const buyFee = valid ? Math.floor(qty * buy * feeRate) : 0;
  const sellFee = valid ? Math.floor(qty * sell * feeRate) : 0;
  const tax = valid ? Math.floor(qty * sell * taxRate) : 0;
  const realized = valid ? (sell - buy) * qty - buyFee - sellFee - tax : 0;
  const realizedPct = valid && buy > 0 ? ((sell - buy) / buy) * 100 : 0;

  function close() {
    setOpen(false);
    setErr(null);
  }

  function submit() {
    if (!valid) return;
    const fd = new FormData();
    fd.set("symbol", sym);
    fd.set("qty", String(qty));
    fd.set("buy_price", String(buy));
    fd.set("sell_price", String(sell));
    fd.set("trade_date", dateStr);
    fd.set("note", note);
    setErr(null);
    startTransition(async () => {
      try {
        await addDayTradeTransaction(fd);
        close();
        setSymbol("");
        setBuyStr("");
        setSellStr("");
        setNote("");
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-amber-900/40 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-900/60"
      >
        記當沖
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={close}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-line-strong bg-surface-dialog p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-lg font-semibold">記一筆當沖</h3>
            <p className="mb-4 text-xs text-zinc-500">
              同日買賣沖銷,損益獨立計算,**不影響持股成本**。當沖證交稅減半。
            </p>

            <div className="space-y-3">
              <Field label="股號">
                <input
                  type="text"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  placeholder="例:2408"
                  className="w-full rounded-xl border border-line-strong bg-surface-sunken px-3 py-2 font-mono text-sm text-zinc-100"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="股數">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={qtyStr}
                    onChange={(e) => setQtyStr(e.target.value)}
                    className="w-full rounded-xl border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-zinc-100"
                  />
                </Field>
                <Field label="日期">
                  <input
                    type="date"
                    value={dateStr}
                    onChange={(e) => setDateStr(e.target.value)}
                    className="w-full rounded-xl border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-zinc-100"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="買進價">
                  <input
                    type="number"
                    step="0.01"
                    value={buyStr}
                    onChange={(e) => setBuyStr(e.target.value)}
                    className="w-full rounded-xl border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-zinc-100"
                  />
                </Field>
                <Field label="賣出價">
                  <input
                    type="number"
                    step="0.01"
                    value={sellStr}
                    onChange={(e) => setSellStr(e.target.value)}
                    className="w-full rounded-xl border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-zinc-100"
                  />
                </Field>
              </div>

              <Field label="備註 (選填)">
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="例:當沖、放空回補"
                  className="w-full rounded-xl border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-zinc-100"
                />
              </Field>
            </div>

            {valid && (
              <div className="mt-4 rounded-xl border border-line bg-surface-sunken p-3 text-sm">
                <Row label="賣出總額" value={(sell * qty).toLocaleString()} />
                <Row label="− 買進總額" value={(buy * qty).toLocaleString()} />
                <Row label="− 手續費(買+賣)" value={(buyFee + sellFee).toLocaleString()} />
                <Row label="− 當沖稅" value={tax.toLocaleString()} />
                <div className="my-2 border-t border-line-soft" />
                <Row
                  label="本次當沖損益"
                  value={realized.toLocaleString()}
                  valueClass={
                    realized > 0
                      ? "text-red-400"
                      : realized < 0
                        ? "text-green-400"
                        : "text-zinc-400"
                  }
                  bold
                />
                <Row
                  label="報酬率(未扣費用)"
                  value={`${realizedPct >= 0 ? "+" : ""}${realizedPct.toFixed(2)}%`}
                  valueClass={
                    realizedPct > 0
                      ? "text-red-400"
                      : realizedPct < 0
                        ? "text-green-400"
                        : "text-zinc-400"
                  }
                />
              </div>
            )}

            {err && (
              <p className="mt-3 rounded-md bg-red-900/30 px-3 py-2 text-xs text-red-200">
                {err}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={close}
                disabled={pending}
                className="rounded-xl border border-line-strong px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                取消
              </button>
              <button
                onClick={submit}
                disabled={!valid || pending}
                className="rounded-xl bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "送出中..." : "確認記錄"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-zinc-400">{label}</label>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  valueClass = "text-zinc-200",
  bold = false,
}: {
  label: string;
  value: string;
  valueClass?: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between py-0.5">
      <span className="text-xs text-zinc-500">{label}</span>
      <span
        className={`tabular-nums ${valueClass} ${bold ? "font-semibold" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
