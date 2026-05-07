"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function addWatch(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!symbol) throw new Error("股號必填");
  const sb = createClient();
  const { error } = await sb.from("watchlist").insert({ symbol, note });
  if (error) throw new Error(error.message);
  revalidatePath("/watchlist");
}

export async function removeWatch(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!id) return;
  const sb = createClient();
  const { error } = await sb.from("watchlist").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/watchlist");
}
