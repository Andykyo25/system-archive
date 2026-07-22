import { SkeletonPage } from "../_components/Skeleton";

// force-dynamic + v_data_health 掃 fetch_log 近 7 天,TTFB 數百 ms → 先給 shell
export default function Loading() {
  return <SkeletonPage cards={3} tables={3} />;
}
