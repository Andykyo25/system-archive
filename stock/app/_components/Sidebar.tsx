"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 左側固定 sidebar。2026-07-17 改版:更簡潔 — 移除項目副標與底部說明,active 用柔和 pill。
// 響應式:< 768px 收摺成 icons only(64px)。
const navItems = [
  { href: "/", label: "Dashboard", icon: "📊" },
  { href: "/holdings", label: "持股", icon: "💼" },
  { href: "/rank", label: "排名", icon: "⭐" },
  { href: "/performance", label: "績效", icon: "📈" },
  { href: "/backtest", label: "Backtest", icon: "🧪" },
  { href: "/settings", label: "設定", icon: "⚙️" },
];

function isActive(path: string, href: string): boolean {
  if (href === "/") return path === "/";
  return path === href || path.startsWith(href + "/");
}

export function Sidebar() {
  const path = usePathname();

  return (
    <aside
      className="sticky top-0 flex h-screen w-16 shrink-0 flex-col border-r border-white/[0.06] bg-zinc-950/50 backdrop-blur md:w-52"
      aria-label="主要導覽"
    >
      <div className="px-3 py-5 md:px-4">
        <div className="flex items-center justify-center gap-2.5 md:justify-start">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-base font-bold text-white shadow-lg shadow-blue-500/20">
            股
          </span>
          <span className="hidden text-sm font-semibold tracking-wide text-zinc-100 md:block">
            持股戰情室
          </span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2 md:px-3">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const active = isActive(path, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  title={item.label}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center justify-center gap-3 rounded-xl px-2 py-2.5 text-sm transition-colors md:justify-start md:px-3 ${
                    active
                      ? "bg-blue-500/10 font-medium text-blue-300 ring-1 ring-inset ring-blue-500/20"
                      : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`grid h-6 w-6 shrink-0 place-items-center text-base ${
                      active ? "" : "opacity-75"
                    }`}
                  >
                    {item.icon}
                  </span>
                  <span className="hidden md:block">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
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
