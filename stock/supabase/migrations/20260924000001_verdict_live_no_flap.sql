-- 盤中閘門去抖動 + 移除 Telegram 推播(2026-09-24,Andy:茂矽整天在「可進場 / 停止」間來回推播)
--
-- 原因:v_verdict_live 以「現價」重算上方套牢量,這個指標在價格上是階梯狀的
--   (120 日成交量落在 (p, 1.2p] 的佔比,p 一動區間邊緣就吃進 / 吐出某個大量日)。
--   茂矽 2342:48.8 → 26.2%、48.9 → 32.1%,價格在 48.8~48.95 震盪即在 30% 門檻兩側反覆。
-- 更根本:有資料支持的是「訊號收盤價的套牢量」(上榜時已擋);以現價重算是未驗證的延伸,
--   且現價重算只會在價格上漲(= 追價情境)時觸發,而追價已驗證不傷。
-- 處置:
--   1. 盤中不再重算套牢量;套牢只在上榜時以訊號收盤判定(v_scan_verdict 不變)
--   2. 停損改為「今日盤中最低價 ≤ 停損 → 當日持續停止」,消除在停損價附近的反覆
--   3. 移除 Telegram 推播:unschedule verdict-watch-tick、drop 函式與其專用欄位
-- rollback:重跑 20260923000004 的 v_verdict_live / verdict_watch 欄位 / cron,
--   及 20260923000006 的 verdict_watch_tick。

select cron.unschedule('verdict-watch-tick');
drop function public.verdict_watch_tick();

drop view public.v_verdict_live;
alter table public.verdict_watch
  drop column live_state, drop column live_reason, drop column live_price,
  drop column live_at, drop column notified_state;
create view public.v_verdict_live as
with w as (
  select * from public.verdict_watch
  where watch_date = (select max(watch_date) from public.verdict_watch)
), q as (
  select c.symbol,
    (array_agg(c.price order by c.quoted_at desc))[1] as price_now,
    max(c.quoted_at) as quoted_at,
    min(c.price) as low_today
  from public.price_intraday_cache c join w on w.symbol = c.symbol
  where (c.quoted_at at time zone 'Asia/Taipei')::date = (now() at time zone 'Asia/Taipei')::date
    and c.price > 0
  group by c.symbol
)
select w.watch_date, w.symbol, w.name, w.signal_close, w.entry_min, w.entry_max, w.stop_price,
  w.supply_share, w.pattern, w.confidence, w.up10_pct, w.n10,
  q.price_now, q.quoted_at, q.low_today,
  case
    when q.price_now is null then 'wait'
    when q.low_today <= w.stop_price then 'block'
    else 'ok'
  end as state,
  case
    when q.price_now is null then '尚無今日報價'
    when q.low_today <= w.stop_price then '今日曾跌破停損 ' || w.stop_price
  end as reason
from w left join q on q.symbol = w.symbol;
comment on view public.v_verdict_live is
  '今日看多名單 × 今日盤中報價:ok 可進場 / block 今日曾跌破停損(當日持續)/ wait 尚無報價。套牢量只在上榜時以訊號收盤判定。';

comment on table public.verdict_watch is
  '今日看多名單凍結(每日 mv 刷新後,freeze_verdict_watch);盤中狀態由 v_verdict_live 即時計算。';
