"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/", label: "Dashboard" },
  { href: "/holdings", label: "持股" },
  { href: "/etf", label: "ETF" },
  { href: "/rank", label: "排名" },
  { href: "/backtest", label: "Backtest" },
  { href: "/settings", label: "設定" },
];

export function TabNav() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 border-b border-zinc-800 px-4">
      {tabs.map((t) => {
        const active = path === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`-mb-px border-b-2 px-4 py-3 text-sm transition-colors ${
              active
                ? "border-blue-500 text-white"
                : "border-transparent text-zinc-400 hover:text-white"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
