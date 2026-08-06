// 各路由 loading.tsx 共用的 skeleton 元件。
// 動機:全站 8 頁皆 force-dynamic(即時報價需求),核心頁 server query 鏈
// 數百 ms~1s(v_holdings_signals/v_holdings_advice),導航時整頁白屏等 TTFB。
// loading.tsx 讓 Next.js 立即回 shell + skeleton,體感載入大幅改善(零資料邏輯風險)。
// 樣式對齊 dark zinc 主題,animate-pulse。

export function SkeletonBlock({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-2xl bg-surface-2 ${className}`}
    />
  );
}

export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonBlock key={i} className="h-24" />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      <SkeletonBlock className="h-6 w-48" />
      <div className="space-y-1.5">
        {Array.from({ length: rows }).map((_, i) => (
          <SkeletonBlock key={i} className="h-10" />
        ))}
      </div>
    </div>
  );
}

export function SkeletonPage({
  cards = 4,
  tables = 2,
}: {
  cards?: number;
  tables?: number;
}) {
  return (
    <div className="space-y-6">
      {cards > 0 && <SkeletonCards count={cards} />}
      {Array.from({ length: tables }).map((_, i) => (
        <SkeletonTable key={i} rows={i === 0 ? 4 : 6} />
      ))}
    </div>
  );
}
