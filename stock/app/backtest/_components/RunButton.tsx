"use client";

import { useFormStatus } from "react-dom";

// 「執行」送出後 server action 會同步等 Edge Function 跑完(數十秒到數分鐘)。
// 沒有這個狀態畫面完全無回饋 → 使用者以為沒反應,重複點擊就會重複跑回測。
// 必須渲染在 <form> 內才讀得到 pending。
export function RunButton({ className }: { className: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      className={className}
      type="submit"
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? "執行中…" : "執行"}
    </button>
  );
}

export function RunNotice() {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <p role="status" className="text-xs text-amber-300 md:col-span-full">
      回測執行中,約需 1~3 分鐘,請勿關閉頁面或重複送出;完成後會自動進入結果頁。
    </p>
  );
}
