"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

// 從 app_settings 拉 fee/tax 設定
// (commission_discount × commission_base_rate = 實際 fee rate)
async function loadFeeSettings(): Promise<{
  feeRate: number;
  taxStock: number;
  taxEtf: number;
}> {
  const sb = createClient();
  const { data, error } = await sb
    .from("app_settings")
    .select("key, value")
    .in("key", [
      "commission_discount",
      "commission_base_rate",
      "sell_tax_stock",
      "sell_tax_etf",
    ]);
  if (error) throw new Error(`讀取費率設定失敗:${error.message}`);
  const rows = (data ?? []) as { key: string; value: number | string }[];
  const map = new Map<string, number>(
    rows.map((r) => [r.key, Number(r.value)]),
  );
  const discount = map.get("commission_discount") ?? 1;
  const base = map.get("commission_base_rate") ?? 0.001425;
  return {
    feeRate: discount * base,
    taxStock: map.get("sell_tax_stock") ?? 0.003,
    taxEtf: map.get("sell_tax_etf") ?? 0.001,
  };
}

function isEtfSymbol(symbol: string): boolean {
  // 台股 ETF 一律以 '00' 開頭(0050、0056、00878、006208、00679B…)
  return /^00\d+/.test(symbol);
}

// 計算手續費(雙邊都收)
function calcFee(qty: number, price: number, feeRate: number): number {
  const raw = qty * price * feeRate;
  // 台股手續費下限 20(慣例),但為了與既有 app_settings 一致計算
  // 暫時不下限,跟 dashboard 算 net 的邏輯一致
  return Math.round(raw * 100) / 100;
}

// 計算證交稅(只賣出收)
function calcTax(qty: number, price: number, taxRate: number): number {
  const raw = qty * price * taxRate;
  return Math.round(raw * 100) / 100;
}

// 新增 BUY transaction(取代原本的 addHolding)
export async function addBuyTransaction(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  const qty = Number(formData.get("qty"));
  const price = Number(formData.get("price"));
  const txnDateRaw = String(formData.get("txn_date") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!symbol) throw new Error("股號必填");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("股數必須是正整數");
  if (!Number.isFinite(price) || price <= 0) throw new Error("價格必須是正數");

  const { feeRate } = await loadFeeSettings();
  const fee = calcFee(qty, price, feeRate);
  const txnDate = txnDateRaw || new Date().toISOString().slice(0, 10);

  const sb = createClient();
  const { error } = await sb.from("holdings_transactions").insert({
    symbol,
    txn_type: "BUY",
    qty,
    price,
    fee,
    tax: 0,
    txn_date: txnDate,
    note,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/holdings");
  revalidatePath("/");
}

// 新增 SELL transaction(從持股表「賣出」按鈕來)
export async function addSellTransaction(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  const qty = Number(formData.get("qty"));
  const price = Number(formData.get("price"));
  const txnDateRaw = String(formData.get("txn_date") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!symbol) throw new Error("股號必填");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("股數必須是正整數");
  if (!Number.isFinite(price) || price <= 0) throw new Error("價格必須是正數");

  // 驗證 net_qty 足夠
  const sb = createClient();
  const { data: current, error: currentErr } = await sb
    .from("v_holdings_current")
    .select("net_qty")
    .eq("symbol", symbol)
    .maybeSingle();
  if (currentErr) throw new Error(`讀取目前持股失敗:${currentErr.message}`);
  if (!current) throw new Error(`沒有持有 ${symbol}`);
  const netQty = Number(current.net_qty);
  if (qty > netQty) {
    throw new Error(`賣出股數 ${qty} 超過目前持有 ${netQty}`);
  }

  const { feeRate, taxStock, taxEtf } = await loadFeeSettings();
  const fee = calcFee(qty, price, feeRate);
  const taxRate = isEtfSymbol(symbol) ? taxEtf : taxStock;
  const tax = calcTax(qty, price, taxRate);
  const txnDate = txnDateRaw || new Date().toISOString().slice(0, 10);

  const { error } = await sb.from("holdings_transactions").insert({
    symbol,
    txn_type: "SELL",
    qty,
    price,
    fee,
    tax,
    txn_date: txnDate,
    note,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/holdings");
  revalidatePath("/");
}

// 砍掉一筆 transaction(誤輸入時用,單筆刪)
// 注意:會影響後續 SELL 的 avg_cost 計算,謹慎使用
export async function deleteTransaction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const sb = createClient();
  const { error } = await sb
    .from("holdings_transactions")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/holdings");
  revalidatePath("/");
}
