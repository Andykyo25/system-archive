"use client";

import { usePathname } from "next/navigation";
import { pageTitleFromPath } from "./Sidebar";

// Top bar:顯示當前 page title。client component,因為要用 usePathname。
// 右側預留 search / user 區。
export function TopBar() {
  const path = usePathname();
  const title = pageTitleFromPath(path);

  return (
    <div className="flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-4 backdrop-blur md:px-6">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold text-zinc-100 md:text-lg">
          {title}
        </h1>
      </div>
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className="hidden md:inline">資料即時更新</span>
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
      </div>
    </div>
  );
}
