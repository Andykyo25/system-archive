"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function addHolding(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  const qty = Number(formData.get("qty"));
  const avg_cost = Number(formData.get("avg_cost"));
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!symbol || !qty || !avg_cost) {
    throw new Error("股號 / 股數 / 均價 必填");
  }

  const sb = createClient();
  const { error } = await sb
    .from("holdings")
    .insert({ symbol, qty, avg_cost, note });
  if (error) throw new Error(error.message);
  revalidatePath("/holdings");
  revalidatePath("/");
}

export async function deleteHolding(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!id) return;
  const sb = createClient();
  const { error } = await sb.from("holdings").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/holdings");
  revalidatePath("/");
}
