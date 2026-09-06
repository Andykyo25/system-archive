// Daily cash accounting for fractional, adjusted-price portfolio simulations.
// Allocation happens when the order window starts, never when a future fill is
// discovered. Unfilled budgets stay cash and cannot be redistributed mid-period.
export type SessionPhase = "open" | "intraday" | "close";

export interface LedgerFill {
  date: string;
  price: number;
  phase: SessionPhase;
}

export interface LedgerOrder {
  id: string;
  symbol: string;
  rank: number | null;
  entry: LedgerFill;
  exit: LedgerFill | null;
  buyFee: number;
  sellFee: number;
  stopTriggered?: boolean;
  scheduledExitDate?: string;
  pendingExitDate?: string;
}

export interface AllocationWindow {
  date: string;
  phase: "open" | "close";
  expiresOn: string;
  slots: number;
  orders: LedgerOrder[];
}

export interface LedgerPosition {
  order: LedgerOrder;
  qty: number;
  invested: number;
  mark: number;
  markDate: string;
}

export interface ClosedLedgerTrade extends LedgerPosition {
  proceeds: number;
  netReturn: number;
}

export interface DailyAccount {
  date: string;
  cash: number;
  reservedCash: number;
  marketValue: number;
  equity: number;
  positions: number;
  stalePositions: number;
}

export const ACCOUNTING_VERSION = "daily-cash-ledger-v1";
export const INITIAL_CAPITAL = 1_000_000;

export function maxDrawdown(equities: number[], initialEquity: number): number {
  let peak = initialEquity;
  let worst = 0;
  for (const equity of equities) {
    peak = Math.max(peak, equity);
    if (peak > 0) worst = Math.max(worst, (peak - equity) / peak);
  }
  return worst * 100;
}

export function dailySharpe(
  equities: number[],
  initialEquity: number,
): number | null {
  let previous = initialEquity;
  const returns: number[] = [];
  for (const equity of equities) {
    if (previous <= 0) return null;
    returns.push(equity / previous - 1);
    previous = equity;
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (returns.length - 1);
  return variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : null;
}

export function runDailyLedger(options: {
  dates: string[];
  windows: AllocationWindow[];
  closeAt: (symbol: string, date: string) => number | null;
  initialCapital?: number;
}) {
  const initialCapital = options.initialCapital ?? INITIAL_CAPITAL;
  if (!Number.isFinite(initialCapital) || initialCapital <= 0)
    throw new Error("invalid_initial_capital");
  const dateSet = new Set(options.dates);
  if (
    dateSet.size !== options.dates.length ||
    options.dates.some((date, i) => i > 0 && date <= options.dates[i - 1])
  ) {
    throw new Error("ledger_dates_must_be_unique_and_ascending");
  }
  const phaseIndex = { open: 0, intraday: 1, close: 2 };
  const ids = new Set<string>();
  for (const window of options.windows) {
    if (
      !dateSet.has(window.date) ||
      !Number.isInteger(window.slots) ||
      window.slots <= 0 ||
      window.expiresOn <= window.date
    ) {
      throw new Error("invalid_allocation_window");
    }
    if (window.orders.length > window.slots)
      throw new Error("orders_exceed_slots");
    for (const order of window.orders) {
      if (ids.has(order.id)) throw new Error("duplicate_order_id");
      ids.add(order.id);
      if (
        !dateSet.has(order.entry.date) ||
        order.entry.date < window.date ||
        order.entry.date >= window.expiresOn ||
        (order.entry.date === window.date &&
          phaseIndex[order.entry.phase] < phaseIndex[window.phase])
      ) {
        throw new Error("entry_outside_allocation_window");
      }
      if (
        !Number.isFinite(order.entry.price) ||
        order.entry.price <= 0 ||
        !Number.isFinite(order.buyFee) ||
        order.buyFee < 0 ||
        order.buyFee >= 1 ||
        !Number.isFinite(order.sellFee) ||
        order.sellFee < 0 ||
        order.sellFee >= 1
      )
        throw new Error("invalid_order_price_or_fee");
      if (
        order.exit &&
        (!dateSet.has(order.exit.date) ||
          order.exit.date < order.entry.date ||
          !Number.isFinite(order.exit.price) ||
          order.exit.price <= 0 ||
          (order.exit.date === order.entry.date &&
            (phaseIndex[order.exit.phase] < phaseIndex[order.entry.phase] ||
              (order.exit.phase === order.entry.phase &&
                order.entry.phase !== "intraday"))))
      ) {
        throw new Error("invalid_exit_fill");
      }
    }
  }

  let cash = initialCapital;
  const positions = new Map<string, LedgerPosition>();
  const pending = new Map<
    string,
    { order: LedgerOrder; budget: number; expiresOn: string }
  >();
  const closed: ClosedLedgerTrade[] = [];
  const daily: DailyAccount[] = [];
  let blockedByExistingPosition = 0;
  let unfundedOrders = 0;
  const reserved = () =>
    Array.from(pending.values()).reduce((sum, p) => sum + p.budget, 0);

  const activate = (date: string, phase: "open" | "close") => {
    for (const window of options.windows.filter(
      (w) => w.date === date && w.phase === phase,
    )) {
      // Prior-session holdings are deliberately excluded from buying power.
      // A delayed exit can fund new orders only after an actual sale, and only
      // at a later allocation window. Each missing slot remains uninvested.
      const budget = Math.max(0, cash - reserved()) / window.slots;
      for (const order of window.orders) {
        if (
          positions.has(order.symbol) ||
          Array.from(pending.values()).some(
            (p) => p.order.symbol === order.symbol,
          )
        ) {
          blockedByExistingPosition++;
          continue;
        }
        if (budget <= initialCapital * 1e-12) {
          unfundedOrders++;
          continue;
        }
        pending.set(order.id, { order, budget, expiresOn: window.expiresOn });
      }
    }
  };

  const buy = (date: string, phase: SessionPhase) => {
    for (const [id, pendingOrder] of pending) {
      const { order, budget } = pendingOrder;
      if (order.entry.date !== date || order.entry.phase !== phase) continue;
      if (budget > cash + initialCapital * 1e-10)
        throw new Error("insufficient_cash_for_reserved_order");
      const qty = budget / (order.entry.price * (1 + order.buyFee));
      cash -= budget;
      if (Math.abs(cash) < initialCapital * 1e-12) cash = 0;
      positions.set(order.symbol, {
        order,
        qty,
        invested: budget,
        mark: order.entry.price,
        markDate: date,
      });
      pending.delete(id);
    }
  };

  const sell = (date: string, phase: SessionPhase) => {
    for (const [symbol, position] of positions) {
      const fill = position.order.exit;
      if (!fill || fill.date !== date || fill.phase !== phase) continue;
      const proceeds = position.qty * fill.price * (1 - position.order.sellFee);
      cash += proceeds;
      closed.push({
        ...position,
        proceeds,
        netReturn: proceeds / position.invested - 1,
      });
      positions.delete(symbol);
    }
  };

  for (const date of options.dates) {
    for (const [id, order] of pending)
      if (date >= order.expiresOn) pending.delete(id);
    // Intraday sale proceeds cannot retroactively fund opening purchases.
    sell(date, "open");
    activate(date, "open");
    buy(date, "open");
    buy(date, "intraday");
    sell(date, "intraday");
    sell(date, "close");
    activate(date, "close");
    buy(date, "close");

    let marketValue = 0;
    let stalePositions = 0;
    for (const position of positions.values()) {
      const close = options.closeAt(position.order.symbol, date);
      if (close != null) {
        if (!Number.isFinite(close) || close <= 0)
          throw new Error("invalid_mark_price");
        position.mark = close;
        position.markDate = date;
      } else {
        // Suspension/data gaps use the last known mark, never a later quote.
        stalePositions++;
      }
      marketValue += position.qty * position.mark;
    }
    const reservedCash = reserved();
    if (
      cash < -initialCapital * 1e-10 ||
      reservedCash > cash + initialCapital * 1e-10
    )
      throw new Error("cash_accounting_invariant_failed");
    daily.push({
      date,
      cash,
      reservedCash,
      marketValue,
      equity: cash + marketValue,
      positions: positions.size,
      stalePositions,
    });
  }
  return {
    initialCapital,
    daily,
    closed,
    openPositions: Array.from(positions.values()),
    blockedByExistingPosition,
    unfundedOrders,
    maxDrawdownPct: maxDrawdown(
      daily.map((d) => d.equity),
      initialCapital,
    ),
    sharpe: dailySharpe(
      daily.map((d) => d.equity),
      initialCapital,
    ),
  };
}
