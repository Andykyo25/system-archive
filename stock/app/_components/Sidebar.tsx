"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 左側固定 sidebar(220px)。取代上方 TabNav。
// 響應式:< 768px 收摺成 icons only(64px)。
const navItems = [
  { href: "/", label: "Dashboard", icon: "📊", desc: "總覽" },
  { href: "/holdings", label: "持股", icon: "💼", desc: "已實現 + 未實現" },
  { href: "/watchlist", label: "產業", icon: "🏭", desc: "10 產業 × 10 股" },
  { href: "/etf", label: "ETF", icon: "🧺", desc: "市值/高股息/主題" },
  { href: "/rank", label: "排名", icon: "⭐", desc: "多因子 + 進場訊號" },
  { href: "/backtest", label: "Backtest", icon: "🧪", desc: "歷史視角回測" },
  { href: "/settings", label: "設定", icon: "⚙️", desc: "費率 / ETF" },
];

function isActive(path: string, href: string): boolean {
  if (href === "/") return path === "/";
  return path === href || path.startsWith(href + "/");
}

export function Sidebar() {
  const path = usePathname();

  return (
    <aside
      className="sticky top-0 flex h-screen w-16 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 md:w-56"
      aria-label="主要導覽"
    >
      <div className="border-b border-zinc-800 px-3 py-4 md:px-4">
        <div className="flex items-center justify-center gap-2 md:justify-start">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-blue-600 text-base font-bold text-white">
            股
          </span>
          <div className="hidden flex-col leading-tight md:flex">
            <span className="text-sm font-semibold text-zinc-100">
              持股戰情室
            </span>
            <span className="text-[10px] text-zinc-500">
              Stock Analysis
            </span>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const active = isActive(path, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  title={`${item.label} · ${item.desc}`}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center justify-center gap-3 rounded-md px-2 py-2 text-sm transition-colors md:justify-start md:px-3 ${
                    active
                      ? "bg-blue-600/15 text-blue-300"
                      : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`grid h-6 w-6 shrink-0 place-items-center text-base ${
                      active ? "" : "opacity-80"
                    }`}
                  >
                    {item.icon}
                  </span>
                  <span className="hidden flex-col leading-tight md:flex">
                    <span className="font-medium">{item.label}</span>
                    <span
                      className={`text-[10px] ${
                        active ? "text-blue-400/70" : "text-zinc-600"
                      }`}
                    >
                      {item.desc}
                    </span>
                  </span>
                  {active && (
                    <span
                      aria-hidden="true"
                      className="ml-auto hidden h-1.5 w-1.5 rounded-full bg-blue-400 md:block"
                    />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="hidden border-t border-zinc-800 px-4 py-3 text-[10px] leading-snug text-zinc-600 md:block">
        <p>單一 user 私人系統</p>
        <p className="mt-0.5">資料源 TWSE + FinMind + Yahoo</p>
      </div>
    </aside>
  );
}

// 把當前路徑換成 page title(顯示在 main top bar)
export function pageTitleFromPath(path: string): string {
  const item =
    navItems.find((i) => i.href !== "/" && isActive(path, i.href)) ??
    (path === "/" ? navItems[0] : null);
  if (item) return item.label;
  // 個股頁 /stocks/[symbol] 或其他 nested route
  if (path.startsWith("/stocks/")) {
    return `個股 · ${path.split("/")[2] ?? ""}`;
  }
  return "持股戰情室";
}
