"use client";

import { useState, useTransition } from "react";
import { addPriceAlert, cancelPriceAlert } from "./actions";

// 到價提醒 dialog(2026-07-10 通用化):
// 快捷掛「停損價 / 加碼價」(來自 v_holdings_advice)或自訂價;
// 自訂價依 vs 現價自動判方向(低於現價 = 跌到提醒,高於 = 漲到提醒),可手動切。
// 觸價後 TG 推播 + one-shot 自動停用(check-price-alerts EF,盤中每 10 分)。

export interface ActiveAlert {
  id: number;
  symbol: string;
  condition: string;
  threshold: number | string | null;
  note: string | null;
}

interface Props {
  symbol: string;
  currentPrice: number | null;
  stopLoss: number | null;
  addPosition: number | null;
  alerts: ActiveAlert[]; // 該 symbol 目前 enabled 的提醒
}

export function AlertDialog({
  symbol,
  currentPrice,
  stopLoss,
  addPosition,
  alerts,
}: Props) {
  const [open, setOpen] = useState(false);
  const [priceStr, setPriceStr] = useState("");
  const [note, setNote] = useState("");
  const [dirOverride, setDirOverride] = useState<"auto" | "below" | "above">(
    "auto",
  );
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const price = Number(priceStr);
  const priceValid = Number.isFinite(price) && price > 0;

  // 方向:auto = 依 vs 現價判;無現價時 auto 不可用,強制手動
  const autoDir =
    priceValid && currentPrice != null
      ? price <= currentPrice
        ? "below"
        : "above"
      : null;
  const dir = dirOverride === "auto" ? autoDir : dirOverride;
  const valid = priceValid && dir != null;

  function close() {
    setOpen(false);
    setErr(null);
  }

  function fillQuick(p: number, label: string) {
    setPriceStr(String(p));
    setNote(label);
    setDirOverride("auto");
  }

  function submit() {
    if (!valid || dir == null) return;
    const fd = new FormData();
    fd.set("symbol", symbol);
    fd.set("condition", dir === "below" ? "price_below" : "price_above");
    fd.set("threshold", String(price));
    fd.set("note", note);
    setErr(null);
    startTransition(async () => {
      try {
        await addPriceAlert(fd);
        setPriceStr("");
        setNote("");
        close();
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function cancel(id: number) {
    const fd = new FormData();
    fd.set("id", String(id));
    setErr(null);
    startTransition(async () => {
      try {
        await cancelPriceAlert(fd);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="到價提醒(觸價 TG 推播)"
        className={`rounded-md px-2 py-1 text-xs font-medium ${
          alerts.length > 0
            ? "bg-amber-900/40 text-amber-200 hover:bg-amber-900/60"
            : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
        }`}
      >
        ⏰{alerts.length > 0 ? alerts.length : ""}
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
            <h3 className="mb-1 text-lg font-semibold">
              到價提醒 <span className="font-mono">{symbol}</span>
            </h3>
            <p className="mb-4 text-xs text-zinc-500">
              現價 {currentPrice != null ? currentPrice.toLocaleString() : "—"}
              ・觸價後 Telegram 推播,一次性(觸發即停用)
            </p>

            {alerts.length > 0 && (
              <div className="mb-4 rounded-xl border border-line bg-surface-sunken p-3">
                <p className="mb-1 text-xs text-zinc-500">已掛提醒</p>
                {alerts.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between py-0.5 text-sm"
                  >
                    <span className="tabular-nums text-zinc-300">
                      {a.condition === "price_below" ? "跌到 ≤" : "漲到 ≥"}{" "}
                      {Number(a.threshold).toLocaleString()}
                      {a.note && (
                        <span className="ml-2 text-xs text-zinc-500">
                          {a.note}
                        </span>
                      )}
                    </span>
                    <button
                      onClick={() => cancel(a.id)}
                      disabled={pending}
                      className="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-300"
                    >
                      取消
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="mb-3 flex flex-wrap gap-2">
              {stopLoss != null && (
                <QuickBtn
                  label={`停損價 ${stopLoss.toLocaleString()}`}
                  onClick={() => fillQuick(stopLoss, "停損提醒")}
                />
              )}
              {addPosition != null && (
                <QuickBtn
                  label={`加碼價 ${addPosition.toLocaleString()}`}
                  onClick={() => fillQuick(addPosition, "加碼價提醒")}
                />
              )}
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">
                  目標價
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={priceStr}
                  onChange={(e) => setPriceStr(e.target.value)}
                  placeholder="輸入價格或點上方快捷"
                  className="w-full rounded-xl border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-zinc-100"
                />
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-zinc-400">方向</span>
                {(
                  [
                    ["auto", autoDir ? `自動(${autoDir === "below" ? "跌到" : "漲到"})` : "自動"],
                    ["below", "跌到 ≤"],
                    ["above", "漲到 ≥"],
                  ] as const
                ).map(([v, label]) => (
                  <label key={v} className="flex items-center gap-1 text-zinc-300">
                    <input
                      type="radio"
                      name="dir"
                      checked={dirOverride === v}
                      onChange={() => setDirOverride(v)}
                      disabled={v === "auto" && currentPrice == null}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">
                  備註(選填,推播時顯示)
                </label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="例:停損提醒、回檔接"
                  className="w-full rounded-xl border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-zinc-100"
                />
              </div>
            </div>

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
                關閉
              </button>
              <button
                onClick={submit}
                disabled={!valid || pending}
                className="rounded-xl bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "送出中..." : "掛提醒"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function QuickBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-md border border-line-strong bg-white/[0.06] px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
    >
      {label}
    </button>
  );
}
