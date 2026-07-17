"use client";

import { usePathname } from "next/navigation";
import { pageTitleFromPath } from "./Sidebar";

// Top bar:僅顯示當前 page title(2026-07-17 改版:移除裝飾性狀態燈)。
export function TopBar() {
  const path = usePathname();
  const title = pageTitleFromPath(path);

  return (
    <div className="flex h-14 items-center border-b border-white/[0.06] bg-zinc-950/50 px-4 backdrop-blur md:px-8">
      <h1 className="truncate text-base font-semibold tracking-wide text-zinc-100">
        {title}
      </h1>
    </div>
  );
}
