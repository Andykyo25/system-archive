export interface ExecutionBar {
  trade_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
}
export interface Fill {
  price: number;
  date: string;
}

export function atrAt(
  bars: ExecutionBar[],
  end: number,
  n = 14,
): number | null {
  if (end < n) return null;
  let sum = 0;
  for (let i = end - n + 1; i <= end; i++) {
    const b = bars[i],
      prev = bars[i - 1];
    if (b.high == null || b.low == null || !Number.isFinite(prev.close))
      return null;
    sum += Math.max(
      b.high - b.low,
      Math.abs(b.high - prev.close),
      Math.abs(b.low - prev.close),
    );
  }
  return sum / n;
}

export function isLockedDown(
  b: ExecutionBar,
  previous: ExecutionBar | undefined,
) {
  return (
    previous != null &&
    b.open != null &&
    b.high != null &&
    b.low != null &&
    b.high === b.low &&
    b.open <= previous.close * 0.905
  );
}

export function nextSell(bars: ExecutionBar[], from: number): Fill | null {
  for (let i = from; i < bars.length; i++) {
    if (!isLockedDown(bars[i], bars[i - 1]) && bars[i].open != null) {
      return { price: bars[i].open!, date: bars[i].trade_date };
    }
  }
  return null;
}

// A stop for session T uses only information available BEFORE T opens.
// Intraday limit fills use conservative same-bar ordering (entry before low).
// No intraday stop on a scheduled opening exit day, after the position is sold.
export function stopExit(
  bars: ExecutionBar[],
  entry: Fill,
  scheduled: { date: string; price: number | null },
  options: {
    pct: number;
    atr: number;
    chandelier: number;
    exitAtOpen: boolean;
  },
) {
  const start = bars.findIndex((b) => b.trade_date === entry.date);
  if (start < 0) return { error: "missing_entry_bar" };
  const seed = atrAt(bars, start - 1);
  if ((options.atr > 0 || options.chandelier > 0) && seed == null)
    return { error: "atr_seed_unavailable" };
  let high = entry.price;
  let trailing: number | null = null;
  for (let i = start; i < bars.length; i++) {
    const b = bars[i];
    if (
      b.trade_date > scheduled.date ||
      (options.exitAtOpen && b.trade_date === scheduled.date)
    )
      break;
    if (i > start && bars[i - 1].high != null)
      high = Math.max(high, bars[i - 1].high!);
    const atr = options.chandelier > 0 ? atrAt(bars, i - 1) : seed;
    if (options.chandelier > 0 && atr == null)
      return { error: "atr_seed_unavailable" };
    const candidate =
      options.pct > 0
        ? entry.price * (1 - options.pct / 100)
        : options.atr > 0
          ? entry.price - options.atr * seed!
          : high - options.chandelier * atr!;
    trailing =
      options.chandelier > 0
        ? Math.max(trailing ?? -Infinity, candidate)
        : candidate;
    if (b.low == null || b.open == null) return { error: "missing_stop_ohlc" };
    if (b.low <= trailing) {
      const locked = isLockedDown(b, bars[i - 1]);
      const fill = locked
        ? nextSell(bars, i + 1)
        : { price: Math.min(b.open, trailing), date: b.trade_date };
      if (!fill) return { error: "unresolved_limit_down", triggered: true, pendingExitDate: b.trade_date };
      return { fill, triggered: true, phase: locked || b.open <= trailing ? "open" as const : "intraday" as const };
    }
  }
  if (scheduled.price == null) return { error: "unresolved_exit", pendingExitDate: scheduled.date };
  return { fill: { price: scheduled.price, date: scheduled.date }, triggered: false, phase: "open" as const };
}
