"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// 新增一筆 backtest run 並觸發 EF(async:true)。
// 流程:
//   1. server action 呼叫 EF(supabase-js functions.invoke,body.async=true)
//   2. EF 先建 backtest_runs row (status=running) 並立刻回 202 + run_id,回測在 EF 背景
//      執行(EdgeRuntime.waitUntil)→ 跑完寫回 status=finished/failed
//   3. 我們拿到 run_id 就 redirect 去詳情頁;running 時詳情頁每 5 秒自動刷新
// 不給 async 時 EF 仍是舊的同步行為(等完整結果,可能撞 EF 150 s 上限而 504),UI 不再使用。
export async function createBacktestRun(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const startDate = String(formData.get("start_date") ?? "").trim();
  const endDateRaw = String(formData.get("end_date") ?? "").trim();
  const topNRaw = String(formData.get("top_n") ?? "10").trim();
  const rebalanceDaysRaw = String(
    formData.get("rebalance_days") ?? "20",
  ).trim();
  const benchmark =
    String(formData.get("benchmark_symbol") ?? "0050").trim() || "0050";

  if (!name) throw new Error("name 必填");
  if (!startDate) throw new Error("start_date 必填");
  const topN = Number(topNRaw);
  const rebalanceDays = Number(rebalanceDaysRaw);
  if (!Number.isFinite(topN) || topN < 1 || topN > 100) {
    throw new Error("top_n 需 1-100");
  }
  if (!Number.isFinite(rebalanceDays) || rebalanceDays < 5 || rebalanceDays > 250) {
    throw new Error("rebalance_days 需 5-250");
  }

  const body = {
    name,
    start_date: startDate,
    end_date: endDateRaw || undefined,
    rebalance_days: rebalanceDays,
    top_n: topN,
    weight_strategy: "equal",
    benchmark_symbol: benchmark,
    async: true,
  };

  const sb = createClient();
  const { data, error } = await sb.functions.invoke("run-backtest", { body });
  if (error) {
    // supabase-js 的 error 可能是 FunctionsHttpError;附加 body 內容供 debug
    const detail =
      typeof data === "object" && data !== null
        ? JSON.stringify(data).slice(0, 500)
        : "";
    throw new Error(`EF run-backtest 失敗:${error.message}${detail ? " · " + detail : ""}`);
  }
  // data: { run_id, status, summary | reason }
  const runId =
    typeof data === "object" && data && "run_id" in data
      ? String((data as { run_id: unknown }).run_id)
      : null;
  if (!runId) {
    throw new Error("EF 沒回 run_id");
  }

  revalidatePath("/backtest");
  redirect(`/backtest/${runId}`);
}

export async function deleteBacktestRun(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("id 必填");
  const sb = createClient();
  const { error } = await sb.from("backtest_runs").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/backtest");
}
