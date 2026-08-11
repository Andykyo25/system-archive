"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  BarChart3,
  Briefcase,
  Crosshair,
  FlaskConical,
  LayoutDashboard,
  Menu,
  Settings,
  Star,
  TrendingUp,
  Waves,
  X,
  type LucideIcon,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "投資組合",
    items: [
      { href: "/", label: "今日戰情", icon: LayoutDashboard },
      { href: "/holdings", label: "持股管理", icon: Briefcase },
      { href: "/performance", label: "績效分析", icon: TrendingUp },
    ],
  },
  {
    label: "研究工具",
    items: [
      { href: "/scan", label: "起漲掃描", icon: Crosshair },
      { href: "/backtest", label: "策略回測", icon: FlaskConical },
    ],
  },
  {
    label: "資料與系統",
    items: [
      { href: "/health", label: "資料健康", icon: Activity },
      { href: "/settings", label: "參數設定", icon: Settings },
    ],
  },
];

// 路由保留，但依既有產品決策不放入主要導覽。
const hiddenItems: NavItem[] = [
  { href: "/swing", label: "波段", icon: Waves },
  { href: "/rank", label: "排名", icon: Star },
];

const visibleNavItems = navGroups.flatMap((group) => group.items);
const navItems: NavItem[] = [...visibleNavItems, ...hiddenItems];
const mobilePrimary = [visibleNavItems[0], visibleNavItems[1], visibleNavItems[3], visibleNavItems[2]];

function isActive(path: string, href: string): boolean {
  if (href === "/") return path === "/";
  return path === href || path.startsWith(`${href}/`);
}

function NavLink({ item, path, onNavigate }: { item: NavItem; path: string; onNavigate?: () => void }) {
  const active = isActive(path, item.href);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all duration-200 ${
        active
          ? "bg-sky-400/10 font-medium text-sky-200 ring-1 ring-inset ring-sky-300/15"
          : "text-slate-400 hover:bg-white/[0.045] hover:text-slate-100"
      }`}
    >
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors ${
          active ? "bg-sky-400/12 text-sky-300" : "bg-white/[0.025] text-slate-500 group-hover:text-slate-300"
        }`}
      >
        <Icon aria-hidden="true" size={17} strokeWidth={active ? 2.2 : 1.8} />
      </span>
      <span>{item.label}</span>
      {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-sky-300" aria-hidden="true" />}
    </Link>
  );
}

export function Sidebar() {
  const path = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const secondaryActive = visibleNavItems.slice(4).some((item) => isActive(path, item.href));

  useEffect(() => {
    if (!moreOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moreOpen]);

  return (
    <>
      <aside
        className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-line bg-[#090e17]/78 backdrop-blur-xl md:flex"
        aria-label="主要導覽"
      >
        <div className="px-5 pb-5 pt-6">
          <div className="flex items-center gap-3">
            <span className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-600 font-semibold text-white shadow-[0_12px_30px_rgba(14,165,233,0.25)]">
              <BarChart3 size={20} aria-hidden="true" />
              <span className="absolute inset-x-2 bottom-1 h-px bg-white/30" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-wide text-slate-100">持股戰情室</p>
              <p className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-slate-600">Equity command</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {navGroups.map((group) => (
            <div key={group.label} className="mb-5 last:mb-0">
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600">
                {group.label}
              </p>
              <ul className="space-y-1">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <NavLink item={item} path={path} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="m-3 rounded-2xl border border-line bg-white/[0.025] p-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-600">Decision support</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
            先確認來源與時間，再使用訊號；本系統不構成投資建議。
          </p>
        </div>
      </aside>

      {moreOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-end bg-black/65 p-3 backdrop-blur-sm md:hidden"
          onClick={() => setMoreOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="完整導覽"
            className="w-full rounded-[1.5rem] border border-line-strong bg-surface-dialog p-3 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between px-2 py-1">
              <div>
                <p className="text-sm font-semibold text-slate-100">完整導覽</p>
                <p className="text-[11px] text-slate-500">研究、資料與系統工具</p>
              </div>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="關閉導覽"
                className="grid h-9 w-9 place-items-center rounded-xl text-slate-400 hover:bg-white/5 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1">
              {visibleNavItems.map((item) => (
                <NavLink key={item.href} item={item} path={path} onNavigate={() => setMoreOpen(false)} />
              ))}
            </div>
          </div>
        </div>
      )}

      <nav
        className="fixed inset-x-3 bottom-3 z-50 grid grid-cols-5 rounded-2xl border border-line-strong bg-[#0b111d]/92 p-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl md:hidden"
        aria-label="行動版導覽"
      >
        {mobilePrimary.map((item) => {
          const active = isActive(path, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-[9px] ${
                active ? "bg-sky-400/10 text-sky-300" : "text-slate-500"
              }`}
            >
              <Icon size={18} strokeWidth={active ? 2.3 : 1.8} aria-hidden="true" />
              <span className="max-w-full truncate">{item.label.replace("分析", "")}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-expanded={moreOpen}
          className={`flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-[9px] ${
            secondaryActive ? "bg-sky-400/10 text-sky-300" : "text-slate-500"
          }`}
        >
          <Menu size={18} strokeWidth={secondaryActive ? 2.3 : 1.8} aria-hidden="true" />
          <span>更多</span>
        </button>
      </nav>
    </>
  );
}

export function pageTitleFromPath(path: string): string {
  const item =
    navItems.find((candidate) => candidate.href !== "/" && isActive(path, candidate.href)) ??
    (path === "/" ? navItems[0] : null);
  if (item) return item.label;
  if (path.startsWith("/stocks/")) return `個股分析 · ${path.split("/")[2] ?? ""}`;
  return "持股戰情室";
}
