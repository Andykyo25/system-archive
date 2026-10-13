-- /scan 讀 R2p 快照,不再每次即時算全市場(2026-10-13)
--
-- 問題:v_scan_verdict 每次都在 price_daily 近 120 天約 17 萬列上跑 5 層 window(sort 溢寫磁碟),
--   pg_stat_statements:PostgREST 呼叫 73 次平均 5.9 秒、最高 7.9 秒,貼著 authenticator 的 8 秒上限
--   (逾時被取消的不會進統計)。10/13 本機驗證時快取未熱 → 「今日看多」整頁載入失敗。
--   結果只在收盤價更新時才變(盤中不變),每次頁面重算是浪費。
-- 作法:mv_scan_verdict = v_scan_verdict 的快照;價格更新時段 UTC 06:00~15:59(台北 14:00~23:59)
--   每 10 分鐘 refresh(postgres 身分,不受 8 秒限制)。只有 /scan 頁面改讀快照;
--   capture_collection_candidates / freeze_r2p_forward / request_verdict_backfill 仍讀即時 view(cron 無 8 秒限制)。
--   價格更新後最多 10 分鐘頁面才換新名單;頁面日期改取快照本身的 trade_date,不會「日期新、名單舊」。
--
-- rollback:select cron.unschedule('refresh-mv-scan-verdict'); drop materialized view public.mv_scan_verdict;
--   並把 app/scan/page.tsx 改回讀 v_scan_verdict。

create materialized view if not exists public.mv_scan_verdict as
select * from public.v_scan_verdict;

create unique index if not exists mv_scan_verdict_symbol on public.mv_scan_verdict(symbol);
grant select on public.mv_scan_verdict to anon, authenticated, service_role;
comment on materialized view public.mv_scan_verdict is
  'v_scan_verdict(R2p)快照,給 /scan 頁面讀;cron refresh-mv-scan-verdict 於價格更新時段每 10 分鐘更新。';

select cron.schedule('refresh-mv-scan-verdict', '*/10 6-15 * * 1-5',
  $job$refresh materialized view concurrently public.mv_scan_verdict$job$);
