import type { RiskEstimate } from "./plan-risk";
export type ActionResult = { error?: string; success?: string };
export interface TradePlan {
  id: string;
  symbol: string;
  strategy_version: string;
  signal_date: string;
  signal_snapshot: {
    name?: string | null;
    score_total?: number;
    close?: number;
  };
  entry_min: number;
  entry_max: number;
  stop_price: number;
  valid_until: string;
  entry_reason: string;
  exit_rule: string;
  status: "watching" | "entered" | "cancelled";
  holdings_transactions?: { price: number; qty: number; txn_date: string }[];
  risk_snapshot?: RiskEstimate | null;
}

export function taipeiDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function validatePlan(form: FormData, today: string) {
  const text = (key: string) => String(form.get(key) ?? "").trim();
  const values = {
    p_symbol: text("symbol"),
    p_signal_date: text("signal_date"),
    p_entry_min: Number(text("entry_min")),
    p_entry_max: Number(text("entry_max")),
    p_stop_price: Number(text("stop_price")),
    p_valid_until: text("valid_until"),
    p_entry_reason: text("entry_reason"),
    p_exit_rule: text("exit_rule"),
  };
  const validDate = (d: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    !Number.isNaN(Date.parse(d)) &&
    new Date(d).toISOString().slice(0, 10) === d;
  if (!/^[0-9A-Za-z]{4,6}$/.test(values.p_symbol))
    throw new Error("股號格式不正確");
  if (
    !validDate(values.p_signal_date) ||
    values.p_signal_date > today ||
    !validDate(values.p_valid_until) ||
    values.p_valid_until < today
  )
    throw new Error("請填寫有效的計畫期限");
  if (
    ![values.p_entry_min, values.p_entry_max, values.p_stop_price].every(
      (v) => Number.isFinite(v) && v > 0,
    )
  )
    throw new Error("價格須為正數");
  if (
    values.p_entry_max < values.p_entry_min ||
    values.p_stop_price >= values.p_entry_min
  )
    throw new Error("買入上限不可低於下限，停損須低於買入下限");
  if (
    [values.p_entry_reason, values.p_exit_rule].some(
      (v) => v.length < 5 || v.length > 1000,
    )
  )
    throw new Error("請填寫 5–1000 字的進場依據與出場規則");
  return values;
}
