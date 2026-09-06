"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { taipeiDate, validatePlan, type ActionResult } from "@/lib/trade-plan";
import { addBuyTransaction } from "@/app/holdings/actions";
import { estimateRisk, type RiskContext } from "@/lib/plan-risk";

export async function recordPlanFill(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  try {
    if (!form.get("plan_id")) return { error: "缺少計畫編號" };
    await addBuyTransaction(form);
    return { success: "成交已記錄並連結原始計畫，可至持股管理查看" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "成交未儲存" };
  }
}

export async function savePlan(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  try {
    const input = validatePlan(form, taipeiDate());
    const sb = createClient();
    let result;
    if (form.get("include_risk") === "on") {
      const [context, stock] = await Promise.all([
        sb.from("v_plan_risk_context").select("*").single(),
        sb
          .from("stock_industry")
          .select("industry_category")
          .eq("symbol", input.p_symbol)
          .maybeSingle(),
      ]);
      if (context.error || stock.error || !context.data)
        return { error: "風險資料無法取得，計畫尚未保存，請稍後重試" };
      const field = (name: string) => String(form.get(name) ?? "").trim();
      // Concentration caps are optional policy; blank means "no such limit".
      const optionalPct = (name: string) =>
        field(name) === "" ? null : Number(field(name));
      if (!field("slippage_pct")) return { error: "請填寫滑價假設" };
      const estimate = estimateRisk(
        context.data as RiskContext,
        {
          symbol: input.p_symbol,
          industry: stock.data?.industry_category ?? null,
          entry: input.p_entry_max,
          stop: input.p_stop_price,
          positionPct: optionalPct("position_pct"),
          industryPct: optionalPct("industry_pct"),
          slippagePct: Number(field("slippage_pct")),
        },
        taipeiDate(),
      );
      result = await sb.rpc("create_breakout_plan_with_risk", {
        p_inputs: input,
        p_risk_snapshot: estimate,
      });
    } else result = await sb.rpc("create_breakout_plan", input);
    const { error } = result;
    if (error) return { error: `計畫未儲存：${error.message}` };
    revalidatePath("/scan");
    return { success: "計畫已保存。可在「我的計畫」記錄實際買入。" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "儲存失敗，請重試" };
  }
}

export async function cancelPlan(
  _previous: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const { data, error } = await createClient()
    .from("trade_plans")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", String(form.get("id")))
    .eq("status", "watching")
    .select("id");
  if (error || !data?.length) return { error: "計畫未取消，請重新整理後重試" };
  revalidatePath("/scan");
  return { success: "已取消，原始計畫保留供檢討" };
}
