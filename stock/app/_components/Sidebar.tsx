"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Briefcase,
  TrendingUp,
  Waves,
  Star,
  FlaskConical,
  Activity,
  Settings,
  type LucideIcon,
} from "lucide-react";

// 左側固定 sidebar。
// 2026-07-17 改版:更簡潔(無副標/底部說明),active 用柔和 pill,玻璃感。
// 2026-07-22 Phase A:三組分區(投資組合/研究/系統)+ lucide icons 換 emoji + token 化。
// 響應式:< 768px 收摺成 icons only(64px)。
// Phase C 新頁(交易行為/Paper-track/警示/資料健康)屆時再加入對應組。
interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "投資組合",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/holdings", label: "持股", icon: Briefcase },
      { href: "/performance", label: "績效", icon: TrendingUp },
    ],
  },
  {
    label: "研究",
    items: [
      { href: "/swing", label: "波段", icon: Waves },
      { href: "/rank", label: "排名", icon: Star },
      { href: "/backtest", label: "Backtest", icon: FlaskConical },
    ],
  },
  {
    label: "系統",
    items: [
      { href: "/health", label: "資料健康", icon: Activity },
      { href: "/settings", label: "設定", icon: Settings },
    ],
  },
];

const navItems: NavItem[] = navGroups.flatMap((g) => g.items);

function isActive(path: string, href: string): boolean {
  if (href === "/") return path === "/";
  return path === href || path.startsWith(href + "/");
}

export function Sidebar() {
  const path = usePathname();

  return (
    <aside
      className="sticky top-0 flex h-screen w-16 shrink-0 flex-col border-r border-line bg-surface-0/50 backdrop-blur md:w-52"
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
        {navGroups.map((group) => (
          <div key={group.label} className="mb-4 last:mb-0">
            <p className="mb-1 hidden px-3 text-[10px] font-medium uppercase tracking-wider text-zinc-600 md:block">
              {group.label}
            </p>
            <ul className="space-y-1">
              {group.items.map((item) => {
                const active = isActive(path, item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      title={item.label}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center justify-center gap-3 rounded-xl px-2 py-2.5 text-sm transition-colors md:justify-start md:px-3 ${
                        active
                          ? "bg-accent/10 font-medium text-blue-300 ring-1 ring-inset ring-accent/20"
                          : "text-zinc-400 hover:bg-surface-2 hover:text-zinc-100"
                      }`}
                    >
                      <Icon
                        aria-hidden="true"
                        size={18}
                        strokeWidth={active ? 2.2 : 1.8}
                        className="shrink-0"
                      />
                      <span className="hidden md:block">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
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
