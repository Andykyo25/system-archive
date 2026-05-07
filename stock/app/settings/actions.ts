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
  revalidatePath("/watchlist");
}

export async function updateForecasts(formData: FormData): Promise<void> {
  const text = String(formData.get("forecasts") ?? "").trim();
  // Format: 一行一筆「symbol=value」(空白/全形等號都接受)
  // 允許 # 開頭的註解行
  const lines = text.split(/\r?\n/);
  const parsed: { symbol: string; value: number | null }[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Za-z0-9\-]+)\s*[=:= ]\s*(.+)$/);
    if (!m) throw new Error(`無法解析:${t}`);
    const symbol = m[1].trim();
    const valStr = m[2].trim();
    if (valStr === "" || valStr === "-" || valStr === "null") {
      parsed.push({ symbol, value: null });
    } else {
      const v = Number(valStr);
      if (!Number.isFinite(v)) throw new Error(`${symbol} 的值不是數字:${valStr}`);
      parsed.push({ symbol, value: v });
    }
  }

  const sb = createClient();
  // 對每個 symbol,update industry_stocks 所有同 symbol 的 row
  for (const { symbol, value } of parsed) {
    const { error } = await sb
      .from("industry_stocks")
      .update({ analyst_forecast_eps_growth_pct: value })
      .eq("symbol", symbol);
    if (error) throw new Error(`更新 ${symbol} 失敗:${error.message}`);
  }

  revalidatePath("/settings");
  revalidatePath("/");
  revalidatePath("/watchlist");
}
