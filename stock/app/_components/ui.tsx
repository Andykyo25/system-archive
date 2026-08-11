import type { ReactNode } from "react";

// Phase A/B 基礎元件(2026-07-22,視覺對齊 07-17 玻璃感改版)
// - 全部 server-safe,零 client JS
// - 卡片慣例:rounded-2xl border-line bg-surface-1(控制項 rounded-lg / nav pill rounded-xl)
//   backdrop-blur 不內建、改 opt-in(全站 13 處表格殼實際都沒有 blur;
//   要玻璃模糊的傳 className="backdrop-blur",如 MorningPanel)
// - tone → class 一律完整字面字串 Record(L24:Tailwind v4 JIT 掃不到動態組裝)
// - Phase B 已套用:TableShell / THead(13 處表格);Card/StatTile 等待 Phase C 新視圖採用

/** 標準卡片:surface-1 + line 邊框 + rounded-2xl */
export function Card({
  title,
  subtitle,
  action,
  padded = true,
  className = "",
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  padded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`surface-card rounded-2xl ${padded ? "p-4" : ""} ${className}`}
    >
      {(title != null || action != null) && (
        <header
          className={`flex items-start justify-between gap-3 ${padded ? "mb-3" : "border-b border-line px-4 py-3"}`}
        >
          <div className="min-w-0">
            {title != null && (
              <h2 className="truncate text-sm font-semibold text-zinc-100">
                {title}
              </h2>
            )}
            {subtitle != null && (
              <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>
            )}
          </div>
          {action != null && <div className="shrink-0">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Dashboard 大數字卡 */
const statTone = {
  up: "text-up",
  down: "text-down",
  neutral: "text-zinc-100",
} as const;

export function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: keyof typeof statTone;
  className?: string;
}) {
  return (
    <div
      className={`surface-card rounded-2xl p-4 ${className}`}
    >
      <p className="text-xs text-zinc-500">{label}</p>
      <p
        className={`mt-1 truncate text-2xl font-semibold tracking-tight ${statTone[tone]}`}
      >
        {value}
      </p>
      {sub != null && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

/** 小徽章:狀態、來源、分類標示 */
const badgeTone = {
  up: "border-up/25 bg-up/10 text-up",
  down: "border-down/25 bg-down/10 text-down",
  ok: "border-ok/25 bg-ok/10 text-ok",
  warn: "border-warn/25 bg-warn/10 text-warn",
  danger: "border-danger/25 bg-danger/10 text-danger",
  accent: "border-accent/25 bg-accent/10 text-accent",
  neutral: "border-line bg-surface-2 text-zinc-400",
} as const;

export function Badge({
  tone = "neutral",
  className = "",
  children,
}: {
  tone?: keyof typeof badgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-lg border px-1.5 py-0.5 text-[11px] font-medium leading-tight ${badgeTone[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** 訊號圓點(持股燈、資料健康) */
const lightTone = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  off: "bg-zinc-600",
} as const;

export function SignalLight({
  tone,
  label,
  className = "",
}: {
  tone: keyof typeof lightTone;
  label?: ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${lightTone[tone]}`}
      />
      {label != null && <span className="text-xs text-zinc-400">{label}</span>}
    </span>
  );
}

/** 頁面區段標題(卡片外) */
export function SectionHeader({
  title,
  desc,
  action,
  className = "",
}: {
  title: ReactNode;
  desc?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-end justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
        {desc != null && <p className="mt-0.5 text-xs text-zinc-500">{desc}</p>}
      </div>
      {action != null && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * 表格外殼:統一 overflow 捲動 + 卡片外框。
 * th/td 樣式仍由各頁自理(各表欄位高度客製)。
 * 放進 flex column 時外層記得 min-w-0(L30)。
 */
export function TableShell({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`overflow-x-auto rounded-2xl border border-line bg-surface-1 ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * 表格 thead 統一樣式(全站 13 處原本各自手刻同一串 class)。
 * divide:"b" = 只有底線(12 處);"y" = 上下都有(holdings 已實現歷史摺疊表)。
 * L24:兩個分支各寫完整字面字串,不做 `border-${divide}` 拼接。
 */
export function THead({
  divide = "b",
  children,
}: {
  divide?: "b" | "y";
  children: ReactNode;
}) {
  return (
    <thead
      className={
        divide === "y"
          ? "border-y border-line text-left text-[11px] uppercase tracking-wider text-zinc-500"
          : "border-b border-line text-left text-[11px] uppercase tracking-wider text-zinc-500"
      }
    >
      {children}
    </thead>
  );
}
