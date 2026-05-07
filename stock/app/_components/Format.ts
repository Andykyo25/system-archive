// 顯示用 helpers
// 注意:台股配色慣例 → 紅 = 漲、綠 = 跌(與美股相反)

export function fmtMoney(
  n: string | number | null | undefined,
  digits = 0,
): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-TW", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function pctColor(n: string | number | null | undefined): string {
  if (n == null) return "text-zinc-400";
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "text-zinc-400";
  return v > 0 ? "text-red-400" : "text-green-400";
}
