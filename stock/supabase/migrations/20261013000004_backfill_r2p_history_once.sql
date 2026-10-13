-- 一次性:全市場日線補到 200 日曆天(R2p scan_supply_share 規格 120 根)(2026-10-13)
--
-- 20261013000001 把 cleanup_market_prices 保留窗 135 → 200 天後,非池股仍只有 6/01 起約 91 根,
-- 要把 [current_date-200, 2026-05-29] 的全市場日線補回來。用既有 backfill-market-history
-- (TWSE MI_INDEX / TPEx 按日端點,不吃 FinMind 配額,ignoreDuplicates 只填洞)。
--
-- 盤中實測 TWSE 約 40 秒 / 日(收盤後平常 2.6 秒 / 日),EF 150 秒牆 → 盤中單次只補得到 3 天,
-- 且盤中密集打 www.twse.com.tw 有被限流、連帶影響 14:30 收盤收料的風險 → 排在收盤後
-- UTC 07:00~09:55(台北 15:00~17:55)每 5 分鐘補 3 個交易日,18:15 freeze_r2p_forward 前完成。
-- 判斷「未補」:該交易日 price_daily 只有池內約 520 檔(全市場約 1,950 檔)→ < 1,800 列視為未補;
-- 0 列 = 休市,略過。全部補完(或過了 10/20)後自行 unschedule。
--
-- rollback:select cron.unschedule('backfill-r2p-history-once');(已補資料為純新增,不刪)

select cron.schedule('backfill-r2p-history-once', '*/5 7-9 * * *', $job$
do $b$
declare
  s date;
begin
  select min(d)::date into s
  from generate_series(current_date - 200, date '2026-05-29', interval '1 day') d
  where extract(isodow from d) < 6
    and (select count(*) from public.price_daily p where p.trade_date = d::date) between 1 and 1799;
  -- 有某日來源本身缺檔時不無限重試:最晚 10/20 停,屆時看 per-day 列數人工判斷
  if s is null or current_date > date '2026-10-20' then
    perform cron.unschedule('backfill-r2p-history-once');
    return;
  end if;
  perform net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/backfill-market-history',
    headers := jsonb_build_object('Authorization', 'Bearer ' || public.read_edge_function_auth(), 'Content-Type', 'application/json'),
    body := jsonb_build_object('start_date', s::text, 'end_date', '2026-05-29', 'max_days', 3),
    timeout_milliseconds := 280000);
end $b$;
$job$);
