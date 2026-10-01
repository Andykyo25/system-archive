-- freeze-verdict-watch 移到法人資料入庫之後(2026-10-01)
--
-- 問題:原排程 07:45 / 14:45 UTC(15:45 / 22:45 Taipei)。法人資料由
--   fetch-finmind-institutional-b1(09:00 UTC = 17:00)與 -b2(09:30 UTC = 17:30)入庫,
--   實測 fetched_at 同日 17:00–17:30。15:45 那次凍結時,當日法人還不在 DB。
--   (目前 v_scan_verdict 的條件尚未使用法人,所以名單內容本來就不受影響;
--    這次只是先把時序擺對,之後要把法人納入條件時不會踩到「名單比資料早」。)
--
-- 做法:
--   freeze-verdict-watch       10:00 UTC(18:00 Taipei),b2 之後 30 分鐘;
--                              加前置閘:當日 stock_institutional 筆數 < 近 20 個有料日中位數 80% → 跳過。
--                              口徑與 freeze-scan-picks-daily、v_data_health coverage 一致。
--   freeze-verdict-watch-late  14:45 UTC(22:45 Taipei),沿用舊的第二次凍結,**不加閘**,
--                              當作保底:法人缺料時不該連名單都沒有(盤中閘門與 Telegram 靠 verdict_watch)。
--
-- 副作用:15:45–18:00 之間 verdict_watch 最新日仍是前一交易日,v_verdict_live 對當日新上榜股
--   顯示「看多」(wait)而非 ok/block,18:00 後恢復。/scan 的名單本身讀 v_scan_verdict,不受影響。
--
-- rollback:
--   select cron.unschedule('freeze-verdict-watch-late');
--   select cron.schedule('freeze-verdict-watch', '45 7,14 * * 1-5', 'select public.freeze_verdict_watch()');

select cron.schedule(
  'freeze-verdict-watch',
  '0 10 * * 1-5',
  $$
  do $body$
  declare
    d date;
    latest_n numeric;
    median_n numeric;
  begin
    select max(trade_date) into d from public.v_breakout_scan;
    select count(*)::numeric into latest_n from public.stock_institutional where trade_date = d;
    select percentile_cont(0.5) within group (order by n) into median_n
    from (
      select count(*)::numeric as n from public.stock_institutional
      where trade_date < d group by trade_date order by trade_date desc limit 20
    ) x;

    if median_n is not null and median_n > 0 and latest_n < median_n * 0.8 then
      raise notice 'freeze-verdict-watch skipped: date=% latest_n=% median_n=% (22:45 late job will freeze)', d, latest_n, median_n;
      return;
    end if;

    perform public.freeze_verdict_watch();
  end $body$;
  $$
);

select cron.schedule(
  'freeze-verdict-watch-late',
  '45 14 * * 1-5',
  'select public.freeze_verdict_watch()'
);
