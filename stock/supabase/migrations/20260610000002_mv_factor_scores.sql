-- mv_factor_scores 物化 + 下游源切換(2026-06-10)
-- 動機:v_factor_scores(v_price_factors 320 天視窗 32,869 列 WindowAgg + 籌碼 4 表)
--   在 v_holdings_advice / v_holdings_signals 的查詢計畫內被重複展開 3 次(~300ms × 3)。
--   物化後 /holdings /rank /TG 推播全鏈改讀 mv(毫秒級)。
-- 安全性:factor 全部來自日更表(price_daily / chip 4 表 / fundamentals / revenue),
--   盤中不變;app_settings weights 在 v_stock_rank 層(未物化)仍即時生效。
-- 新鮮度:cron 平日 08:50 / 14:50 / 15:50 / 16:50 / 17:50 Taipei refresh,
--   蓋過所有資料更新點(08:45 preopen backfill / 14:30 主力 / 15:30 fallback /
--   16:30 valuation / 17:00-17:10 籌碼);週末 fundamentals 由週一 08:50 跟上;
--   月初 reselect(11:00 Taipei)最遲 14:50 跟上(/rank 舊 universe 數小時,可接受)。
-- 手動 backfill 後記得:refresh materialized view concurrently public.mv_factor_scores;

create materialized view public.mv_factor_scores as
  select * from public.v_factor_scores;

-- refresh concurrently 必需 unique index
create unique index idx_mv_factor_scores_symbol on public.mv_factor_scores(symbol);

-- 下游源切換:DO block 取現定義機械替換(零手打 drift;pattern 不符即 fail-fast)
do $$
declare def text;
begin
  def := pg_get_viewdef('public.v_stock_rank', true);
  if def not like '%FROM v_factor_scores fs%' then
    raise exception 'v_stock_rank: FROM v_factor_scores fs not found';
  end if;
  execute 'create or replace view public.v_stock_rank as '
    || replace(def, 'FROM v_factor_scores fs', 'FROM mv_factor_scores fs');

  def := pg_get_viewdef('public.v_holdings_signals', true);
  if def not like '%LEFT JOIN v_factor_scores f%' then
    raise exception 'v_holdings_signals: LEFT JOIN v_factor_scores f not found';
  end if;
  execute 'create or replace view public.v_holdings_signals as '
    || replace(def, 'LEFT JOIN v_factor_scores f', 'LEFT JOIN mv_factor_scores f');
end $$;

select cron.schedule(
  'refresh-mv-factor-scores',
  '50 0,6,7,8,9 * * 1-5',
  'refresh materialized view concurrently public.mv_factor_scores'
);
