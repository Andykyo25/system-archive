import "server-only";

// Server Component 取 Supabase 資料用的 unwrap helper。
//
// 問題(全系統審查 A3):全站唯讀 page 都寫 `const { data } = await sb...`,
//   丟掉 error,再 `(data as T[]) ?? []`。一旦 view 改名/欄位 typo/RLS 變動/
//   DB 故障 → query 回 {data:null, error} → 頁面靜默顯示空表(empty state),
//   使用者以為「沒資料」而非「出錯了」。這正是 L34/L42 反覆強調的
//   「無資料 ≠ 沒問題、沉默失敗最危險」。
//
// unwrap:核心 query 失敗就 throw,冒泡到 app/error.tsx boundary 顯示明確錯誤。
//   次要/lookup query(失敗只影響單一區塊)可不套,容忍 null。

type SbResult<T> = { data: T; error: { message: string; code?: string } | null };

export function unwrap<T>(res: SbResult<T>, label: string): T {
  if (res.error) {
    throw new Error(`Supabase 查詢失敗 [${label}]: ${res.error.message}`);
  }
  return res.data;
}
