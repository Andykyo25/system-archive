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
  revalidatePath("/etf");
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
  revalidatePath("/etf");
}

export async function deleteEtf(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  if (!symbol) return;
  const sb = createClient();
  const { error } = await sb.from("etf_metadata").delete().eq("symbol", symbol);
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
  revalidatePath("/etf");
}
