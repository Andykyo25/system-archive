"use client";

import { useState, useTransition } from "react";
import { addSellTransaction } from "./actions";

interface Props {
  symbol: string;
  netQty: number;
  avgCost: number;
  currentPrice: number | null;
  feeRate: number;
  taxRate: number;
}

// 賣出 dialog:輸入 qty + price + date → 預覽實現損益(扣手續費 + 證交稅)→ 確認送出
export function SellDialog({
  symbol,
  netQty,
  avgCost,
  currentPrice,
  feeRate,
  taxRate,
}: Props) {
  const [open, setOpen] = useState(false);
  const [qtyStr, setQtyStr] = useState(String(netQty));
  const [priceStr, setPriceStr] = useState(
    currentPrice ? currentPrice.toFixed(2) : "",
  );
  const [dateStr, setDateStr] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const qty = Number(qtyStr);
  const price = Number(priceStr);
  const qtyValid = Number.isFinite(qty) && qty > 0 && qty <= netQty;
  const priceValid = Number.isFinite(price) && price > 0;
  const valid = qtyValid && priceValid;

  // 預覽計算
  const proceeds = valid ? qty * price : 0;
  const fee = valid ? Math.round(qty * price * feeRate * 100) / 100 : 0;
  const tax = valid ? Math.round(qty * price * taxRate * 100) / 100 : 0;
  const cost = valid ? avgCost * qty : 0;
  const realized = valid ? proceeds - cost - fee - tax : 0;
  const realizedPct = valid && cost > 0 ? ((price - avgCost) / avgCost) * 100 : 0;

  function close() {
    setOpen(false);
    setErr(null);
  }

  function submit() {
    if (!valid) return;
    const fd = new FormData();
    fd.set("symbol", symbol);
    fd.set("qty", String(qty));
    fd.set("price", String(price));
    fd.set("txn_date", dateStr);
    fd.set("note", note);
    setErr(null);
    startTransition(async () => {
      try {
        await addSellTransaction(fd);
        close();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setErr(msg);
      }
    });
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-red-900/40 px-3 py-1 text-xs font-medium text-red-200 hover:bg-red-900/60"
      >
        賣出
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={close}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-lg font-semibold">
              賣出 <span className="font-mono">{symbol}</span>
            </h3>
            <p className="mb-4 text-xs text-zinc-500">
              目前持有 {netQty} 股,均價 {avgCost.toFixed(2)}
            </p>

            <div className="space-y-3">
              <Field label="股數">
                <input
                  type="number"
                  min={1}
                  max={netQty}
                  step={1}
                  value={qtyStr}
                  onChange={(e) => setQtyStr(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-100"
                />
                {!qtyValid && qtyStr !== "" && (
                  <p className="mt-1 text-xs text-red-400">
                    股數需介於 1 ~ {netQty}
                  </p>
                )}
              </Field>

              <Field label="賣出價">
                <input
                  type="number"
                  step="0.01"
                  value={priceStr}
                  onChange={(e) => setPriceStr(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-100"
                />
              </Field>

              <Field label="日期">
                <input
                  type="date"
                  value={dateStr}
                  onChange={(e) => setDateStr(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-100"
                />
              </Field>

              <Field label="備註 (選填)">
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="例:停利、停損、調節"
                  className="w-full rounded-xl border border-white/10 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-100"
                />
              </Field>
            </div>

            {valid && (
              <div className="mt-4 rounded-xl border border-white/[0.06] bg-zinc-950/80 p-3 text-sm">
                <Row label="賣出總額" value={proceeds.toLocaleString()} />
                <Row label="− 手續費" value={fee.toLocaleString()} />
                <Row label="− 證交稅" value={tax.toLocaleString()} />
                <Row label="− 成本" value={cost.toLocaleString()} />
                <div className="my-2 border-t border-white/[0.04]" />
                <Row
                  label="本次實現損益"
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
                className="rounded-xl border border-white/10 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                取消
              </button>
              <button
                onClick={submit}
                disabled={!valid || pending}
                className="rounded-xl bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "送出中..." : "確認賣出"}
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
