"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function addPaperOrder(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  const side = String(formData.get("side") ?? "");
  const qty = Number(formData.get("qty"));
  const price = Number(formData.get("price"));
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!symbol || (side !== "buy" && side !== "sell") || !qty || !price) {
    throw new Error("股號 / 買賣別 / 股數 / 價格 必填");
  }
  const sb = createClient();
  const { error } = await sb
    .from("paper_orders")
    .insert({ symbol, side, qty, price, note });
  if (error) throw new Error(error.message);
  revalidatePath("/paper");
  revalidatePath("/");
}
