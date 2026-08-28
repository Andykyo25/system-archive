"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function updateSetting(formData: FormData): Promise<void> {
  const key = String(formData.get("key") ?? "").trim();
  const valueRaw = String(formData.get("value") ?? "").trim();
  const value = Number(valueRaw);
  if (!key) throw new Error("key 必填");
  if (!Number.isFinite(value)) throw new Error("數值必須是數字");

  const sb = createClient();
  const { error } = await sb
    .from("app_settings")
    .update({ value, updated_at: new Date().toISOString() })
    .eq("key", key);
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
  revalidatePath("/");
  revalidatePath("/holdings");
  revalidatePath("/rank");
}

// ETF metadata CRUD
export async function upsertEtf(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  if (!symbol) throw new Error("股號必填");

  const name = String(formData.get("name") ?? "").trim() || null;
  const category = String(formData.get("category") ?? "").trim() || "其他";
  const expRaw = String(formData.get("expense_ratio") ?? "").trim();
  const sizeRaw = String(formData.get("fund_size_billion") ?? "").trim();
  const isActive = formData.get("is_active_etf") === "on";
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const expense_ratio = expRaw === "" ? null : Number(expRaw);
  const fund_size_billion = sizeRaw === "" ? null : Number(sizeRaw);
  if (expense_ratio !== null && !Number.isFinite(expense_ratio)) {
    throw new Error("內扣費用必須是數字");
  }
  if (fund_size_billion !== null && !Number.isFinite(fund_size_billion)) {
    throw new Error("規模必須是數字");
  }

  const sb = createClient();
  const { error } = await sb.from("etf_metadata").upsert(
    {
      symbol,
      name,
      category,
      expense_ratio,
      fund_size_billion,
      is_active_etf: isActive,
      notes,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "symbol" },
  );
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}

export async function deleteEtf(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  if (!symbol) return;
  const sb = createClient();
  const { error } = await sb.from("etf_metadata").delete().eq("symbol", symbol);
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}

// 資金流水(2026-08-28)
//
// 為什麼需要這張表:`app_settings.initial_capital` 是單一常數,只描述「一開始放了多少錢」。
// Andy 2026-08 加碼入金後,v_account_equity_daily 的 cash 算式
// (投入本金 + 交易現金流 + 當沖損益)就會算出負數 —— 而報酬率的分母也就錯了。
// 每一筆入金/出金都要記在這裡,峰值 / 回撤 / TWR 才有意義。
export async function addCapitalFlow(formData: FormData): Promise<void> {
  const flowDate = String(formData.get("flow_date") ?? "").trim();
  const amount = Number(formData.get("amount"));
  const flowType = String(formData.get("flow_type") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!flowDate) throw new Error("日期必填");
  if (!Number.isFinite(amount) || amount <= 0)
    throw new Error("金額必須是正數(方向由「入金/出金」決定)");
  if (flowType !== "deposit" && flowType !== "withdrawal")
    throw new Error("類型只能是入金或出金");

  const sb = createClient();
  const { error } = await sb.from("capital_flows").insert({
    flow_date: flowDate,
    amount,
    flow_type: flowType,
    note,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
  revalidatePath("/performance");
}

export async function deleteCapitalFlow(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("id 必填");

  const sb = createClient();
  const { error } = await sb.from("capital_flows").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
  revalidatePath("/performance");
}
