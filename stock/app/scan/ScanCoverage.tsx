import { unstable_cache } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { readAll, unwrap } from "@/lib/db";

// HEAD exact counts have failed on this expensive view in production.
// Count paginated symbols without blocking candidates or hiding read failures.
const loadCoverage = unstable_cache(async () => {
  const sb = createClient();
  const result = await readAll<{ symbol: string }>((from, to) => sb
    .from("v_breakout_scan").select("symbol").order("symbol").range(from, to));
  return (unwrap(result, "掃描涵蓋數") ?? []).length;
}, ["scan:coverage:v1"], { revalidate: 300 });

export async function ScanCoverage() {
  let total: number | null = null;
  try { total = await loadCoverage(); }
  catch (error) {
    console.error("[scan:coverage]", error);
  }
  return total == null ? <span className="text-sm text-amber-300">暫時無法取得</span> : <>{total} 檔</>;
}
