-- 清理 price_intraday_cache 舊資料 + 每日自動清理 cron(2026-06-02 效能優化 A)
--
-- 背景:price_intraday_cache(即時報價快取)每分鐘寫入、3 週累積 42.8 萬列從不清理。
-- v_latest_price_realtime / v_holdings_full 取「今天最新報價」時對此表 seq scan
-- (filter quoted_at::date = current_date 是 expression 不走 index)→ v_holdings_full
-- 單次 4.1s(dashboard 每次 render 都跑)。清到近 3 天(view 只用「今天」,3 天為
-- 時區/跨日緩衝)後剩 8.3 萬列,v_holdings_full 4.1s → 2.37s。
--
-- 剩餘 ~2.37s 主要是 daily_recent 掃 price_daily 12.7 萬全歷史取最近收盤(= 優化 B,
-- 改 v_latest_price_realtime:intraday filter 改 sargable + daily 加時間下界,另案)。

-- 一次性清現有積壓(idempotent,重跑只刪當下 >3 天的)
delete from price_intraday_cache where quoted_at < current_date - interval '3 days';

-- 每日 18:00 UTC(02:00 Taipei,盤後夜間)自動清 >3 天,維持表小不再無限長
select cron.schedule(
  'purge-intraday-cache',
  '0 18 * * *',
  $$delete from price_intraday_cache where quoted_at < current_date - interval '3 days'$$
);
