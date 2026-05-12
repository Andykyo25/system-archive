"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// 新增一筆 backtest run 並 fire-and-forget 觸發 EF。
// 注意:EF 可能跑 30s~120s,直接 await 會卡住 form。
// 流程:
//   1. server action 呼叫 EF(supabase-js functions.invoke)
//   2. EF 內部會建 backtest_runs row (status=running) → 跑完 → status=finished/failed
//   3. 我們 await 完拿 run_id,redirect 去詳情頁
//
// 若希望非同步(form submit 立刻返回),可改成 fetch 不 await。但因為 EF 內已會建 row
// + 寫 fetch_log,等 EF 完成是合理 UX(避免使用者看不到 row)。
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
