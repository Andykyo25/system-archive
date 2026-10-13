-- Rollback:20261013000001 ~ 20261013000006(看多候選三面因子 / 即時補料 / R2p 120 根歷史 / /scan 快照)
--
-- 前端:先把 app/scan/page.tsx 改回讀 v_scan_verdict、v_stock_rank,app/stocks/[symbol]/page.tsx 與
--   lib/holding-analysis.ts 改回 v_stock_rank 並部署,再執行本檔(否則頁面會讀到被刪的 view)。
--
-- 前置檢查:schema_rollback_snapshots 必須有 5 列(3 view + 2 function)
--   select object_name, kind, saved_at from public.schema_rollback_snapshots
--   where tag = '20261013_verdict_factor_coverage';
-- 驗證:執行後 v_stock_rank 列數 / expected_rank 指紋回到改動前;v_chip_factors 不含熱股池。
-- 不刪的東西:verdict_backfill_requests(稽核紀錄)、已補入的價格 / 籌碼資料(純新增,PIT 保留)。
-- 價格保留窗回到 135 天後,下次 cleanup_market_prices 會清掉非池股 135 天前的資料。

-- 1. 停止即時補料、一次性歷史回補、/scan 快照
select cron.unschedule(j) from unnest(array['request-verdict-backfill', 'backfill-r2p-history-once', 'refresh-mv-scan-verdict']) j
where exists (select 1 from cron.job where jobname = j);
drop function if exists public.request_verdict_backfill();
drop materialized view if exists public.mv_scan_verdict;

-- 2. 還原 view / function 原文(先 v_stock_rank,解除對 v_stock_rank_all 的依賴)
do $rb$
declare
  r record;
begin
  if (select count(*) from public.schema_rollback_snapshots where tag = '20261013_verdict_factor_coverage') <> 5 then
    raise exception 'rollback snapshot incomplete, abort';
  end if;
  for r in
    select object_name, kind, definition from public.schema_rollback_snapshots
    where tag = '20261013_verdict_factor_coverage'
    order by case object_name when 'v_stock_rank' then 1 when 'v_price_factors' then 2 when 'v_chip_factors' then 3 else 4 end
  loop
    if r.kind = 'view' then
      execute format('create or replace view public.%I as %s', r.object_name, r.definition);
    else
      execute r.definition;
    end if;
  end loop;
end $rb$;

-- 3. 移除新 view
drop view if exists public.v_stock_rank_all;
drop view if exists public.v_factor_universe;
drop view if exists public.v_rank_universe;

-- 4. 重新計算因子
refresh materialized view concurrently public.mv_factor_scores;
