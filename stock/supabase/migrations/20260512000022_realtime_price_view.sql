-- M8.3:v_latest_price_realtime
--
-- 把「現價」的三層 fallback 集中到一個 view:
--   1) intraday < 30 分鐘前 → source='yahoo'(最即時)
--   2) price_daily 今日 close → source='twse_today'(主力當日已到)
--   3) price_daily 昨日 close → source='twse_yesterday'(隔夜 / 主力遲到)
--
-- 對齊 v_latest_price 的 surface:
--   symbol, current_price, as_of_ts, trade_date, source, is_provisional, market_state
-- UI 之後依 source 決定 timestamp 顯示格式

drop view if exists public.v_latest_price_realtime cascade;

create view public.v_latest_price_realtime as
with intraday_latest as (
  select distinct on (symbol)
    symbol,
    price,
    quoted_at,
    market_state,
    source
  from public.price_intraday_cache
  where quoted_at >= now() - interval '30 minutes'
  order by symbol, quoted_at desc
),
daily_today as (
  select distinct on (symbol)
    symbol,
    close,
    trade_date,
    is_provisional,
    source
  from public.price_daily
  where trade_date = current_date
  order by symbol, trade_date desc
),
daily_recent as (
  -- 「昨日(或更早)收盤」:filter < current_date 確保 source='twse_yesterday' 語意精確
  select distinct on (symbol)
    symbol,
    close,
    trade_date,
    is_provisional,
    source
  from public.price_daily
  where trade_date < current_date
  order by symbol, trade_date desc
),
all_symbols as (
  select symbol from intraday_latest
  union
  select symbol from daily_recent
)
select
  s.symbol,
  coalesce(i.price, dt.close, dr.close)::numeric(12,4) as current_price,
  case
    when i.price is not null then i.quoted_at
    when dt.close is not null then dt.trade_date::timestamptz
    when dr.close is not null then dr.trade_date::timestamptz
  end as as_of_ts,
  case
    when i.price is not null then null::date
    when dt.close is not null then dt.trade_date
    when dr.close is not null then dr.trade_date
  end as trade_date,
  case
    when i.price is not null then 'yahoo'
    when dt.close is not null then 'twse_today'
    when dr.close is not null then 'twse_yesterday'
  end as source,
  case
    when i.price is not null then false
    when dt.close is not null then dt.is_provisional
    when dr.close is not null then dr.is_provisional
  end as is_provisional,
  i.market_state
from all_symbols s
left join intraday_latest i on i.symbol = s.symbol
left join daily_today dt on dt.symbol = s.symbol
left join daily_recent dr on dr.symbol = s.symbol;

comment on view public.v_latest_price_realtime is
  '三層 fallback 現價:Yahoo 即時(<30min) > 今日收盤 > 最近收盤。
   source 欄位告訴 UI 該怎麼顯示 timestamp(yahoo=time / twse=date)。';
