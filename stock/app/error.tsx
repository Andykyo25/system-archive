"use client";

// 全站 error boundary(全系統審查 A3)。
// 之前完全沒有任何 error.tsx → 任何未捕捉的 throw(DB 故障、unwrap 失敗、
//   render exception)都讓使用者看到 Next.js 預設崩潰畫面或白屏。
// 配合 lib/db.ts 的 unwrap:核心 query 失敗會 throw 到這裡,顯示明確錯誤 +
//   重試,而非靜默空表偽裝正常(L34/L42)。

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h2 className="text-lg font-semibold text-red-400">頁面載入失敗</h2>
      <p className="max-w-xl break-words text-sm text-zinc-400">
        {error.message || "發生未預期的錯誤"}
      </p>
      {error.digest && (
        <p className="text-xs text-zinc-600">digest: {error.digest}</p>
      )}
      <button
        onClick={reset}
        className="rounded-md border border-line-strong bg-zinc-900 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
      >
        重試
      </button>
    </div>
  );
}
