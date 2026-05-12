import { fmtMoney, formatPriceTimestamp } from "./Format";

// 顯示價格 + 來源 timestamp。
// is_provisional → 黃字 + ⚠
// asOfTs / source → 第二行顯示「N min ago · twse_mis」「今日收盤」「YYYY-MM-DD 收盤」
//
// 若沒傳 asOfTs / source,fallback 用 date(舊呼叫端 backward-compat)。
export function PriceCell({
  value,
  isProvisional,
  date,
  asOfTs,
  source,
  digits = 2,
}: {
  value: string | number | null | undefined;
  isProvisional?: boolean | null;
  date?: string | null;
  asOfTs?: string | null;
  source?: string | null;
  digits?: number;
}) {
  const ts = formatPriceTimestamp(asOfTs, source, date);
  const showProv = isProvisional || ts.provisional;

  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span
        className={`tabular-nums ${showProv ? "text-amber-400" : ""}`}
        title={ts.tooltip}
      >
        {fmtMoney(value, digits)}
        {showProv ? <span className="ml-1 text-xs">⚠</span> : null}
      </span>
      {ts.text !== "—" && (
        <span
          className="text-[10px] text-zinc-500"
          title={ts.tooltip}
        >
          {ts.text}
        </span>
      )}
    </span>
  );
}
