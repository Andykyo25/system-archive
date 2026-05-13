-- M9.3+: v_latest_price_realtime intraday window 從 30 min → 同交易日
--
-- 問題:13:30 收盤 Yahoo MIS 抓到 216.5(REGULAR,真實收盤)
--      14:00 後 30 min cache 過期 → fallback 到 daily_recent → 顯示昨日 220
-- 修法:intraday window 改成「同一交易日內」(quoted_at::date = current_date)
--      盤中 ≤ 30 min 一樣優先;盤後同日內也保留收盤價(直到隔天)
--      隔天 quoted_at 變昨天,自然 fallback 到 daily_today(主力 cron 寫入後)
--
-- create or replace 因為 output column 不變,downstream view 不需 cascade rebuild

create or replace view public.v_latest_price_realtime as
with intraday_latest as (
  select distinct on (symbol) symbol, price, quoted_at, market_state, source
  from public.price_intraday_cache
  where quoted_at::date = current_date
  order by symbol, quoted_at desc
),
daily_today as (
  select distinct on (symbol) symbol, close, trade_date, is_provisional, source
  from public.price_daily
  where trade_date = current_date
  order by symbol, trade_date desc
),
daily_recent as (
  select distinct on (symbol) symbol, close, trade_date, is_provisional, source
  from public.price_daily
  where trade_date < current_date
  order by symbol, trade_date desc
),
all_symbols as (
  select symbol from intraday_latest union select symbol from daily_recent
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
    when i.price is not null then i.source
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
