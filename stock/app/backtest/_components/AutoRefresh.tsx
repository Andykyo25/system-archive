"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// 回測在背景執行時,每隔幾秒重新取一次伺服端資料;完成後畫面自動換成結果。
export function AutoRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
