"use client";

import { usePathname } from "next/navigation";
import { pageTitleFromPath } from "./Sidebar";

const pageDescriptions: Record<string, string> = {
  "/": "盤前資訊、持股狀態與今日決策",
  "/holdings": "部位、成本與交易紀錄",
  "/performance": "資產曲線與已實現績效",
  "/scan": "突破候選、交易計畫與證據追蹤",
  "/backtest": "策略樣本與歷史驗證",
  "/health": "來源時效、涵蓋率與排程狀態",
  "/settings": "資金與策略參數",
};

function descriptionFromPath(path: string): string {
  if (path.startsWith("/stocks/")) return "趨勢、因子、籌碼與估值總覽";
  const key = Object.keys(pageDescriptions).find(
    (candidate) => candidate !== "/" && path.startsWith(candidate),
  );
  return pageDescriptions[key ?? "/"];
}

export function TopBar() {
  const path = usePathname();
  const title = pageTitleFromPath(path);
  const description = descriptionFromPath(path);

  return (
    <div className="sticky top-0 z-30 flex min-h-16 items-center border-b border-line bg-[#070b12]/82 px-4 py-2 backdrop-blur-xl sm:px-6 md:px-8 xl:px-10">
      <div className="min-w-0">
        <p className="eyebrow mb-0.5 hidden sm:block">Taiwan equity command</p>
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="truncate text-sm font-semibold tracking-wide text-zinc-100 sm:text-base">
            {title}
          </h1>
          <p className="hidden truncate text-xs text-slate-500 lg:block">
            {description}
          </p>
        </div>
      </div>
      <div className="ml-auto hidden items-center gap-2 text-[11px] text-slate-500 sm:flex">
        <span className="h-1 w-1 rounded-full bg-sky-400" aria-hidden="true" />
        資料時間以各卡片標示為準
      </div>
    </div>
  );
}
