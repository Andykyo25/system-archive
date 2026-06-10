"use server";

// /rank 一鍵掛耐心價到價提醒(「好股等好價」工程 D)
// 寫 alert_rules(condition=price_below),盤中 cron check-price-alerts 每 10 分比價,
// 觸價 TG 推播 + one-shot 停用。

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function addPatienceAlert(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  const price = Number(formData.get("price"));
  if (!/^[0-9A-Za-z]{4,6}$/.test(symbol) || !Number.isFinite(price) || price <= 0) {
    throw new Error("invalid patience alert input");
  }
  const sb = createClient();
  // 防重:同 symbol 未觸發的 price_below rule 先停用再插新(idempotent 重掛 = 更新價)
  await sb
    .from("alert_rules")
    .update({ enabled: false })
    .eq("symbol", symbol)
    .eq("condition", "price_below")
    .eq("enabled", true);
  const { error } = await sb.from("alert_rules").insert({
    symbol,
    condition: "price_below",
    threshold: price,
    note: "耐心價 MA20",
  });
  if (error) throw new Error(`addPatienceAlert: ${error.message}`);
  revalidatePath("/rank");
}

export async function cancelPatienceAlert(formData: FormData): Promise<void> {
  const symbol = String(formData.get("symbol") ?? "").trim();
  if (!/^[0-9A-Za-z]{4,6}$/.test(symbol)) throw new Error("invalid symbol");
  const sb = createClient();
  const { error } = await sb
    .from("alert_rules")
    .update({ enabled: false })
    .eq("symbol", symbol)
    .eq("condition", "price_below")
    .eq("enabled", true);
  if (error) throw new Error(`cancelPatienceAlert: ${error.message}`);
  revalidatePath("/rank");
}
