import { fmtMoney } from "./Format";

// 顯示價格,若 is_provisional 則加角標 + 變色提醒「來源是備案」
export function PriceCell({
  value,
  isProvisional,
  date,
}: {
  value: string | number | null | undefined;
  isProvisional?: boolean | null;
  date?: string | null;
}) {
  const tip = isProvisional
    ? `備案資料 (FinMind) ${date ?? ""}`
    : date
      ? `主力資料 (TWSE/TPEX) ${date}`
      : undefined;
  return (
    <span
      className={`tabular-nums ${isProvisional ? "text-amber-400" : ""}`}
      title={tip}
    >
      {fmtMoney(value, 2)}
      {isProvisional ? <span className="ml-1 text-xs">⚠</span> : null}
    </span>
  );
}
