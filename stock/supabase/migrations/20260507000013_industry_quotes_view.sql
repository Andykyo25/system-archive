-- v_industry_quotes:每個產業熱門股的即時報價 + 5 日 / 20 日漲幅
-- 排序:在 UI 端依 pct_5d 排序;這個 view 只負責輸出,不排序

create or replace view public.v_industry_quotes as
with ranked as (
  select
    symbol,
    trade_date,
    close,
    is_provisional,
    row_number() over (partition by symbol order by trade_date desc) as rn
  from public.price_daily
),
today as (
  select symbol, trade_date, close, is_provisional from ranked where rn = 1
),
prev_5d as (
  select symbol, close as close_5d_ago from ranked where rn = 6
),
prev_20d as (
  select symbol, close as close_20d_ago from ranked where rn = 21
)
select
  i.id,
  i.industry,
  i.symbol,
  i.name,
  i.display_order,
  t.close as current_price,
  t.trade_date,
  t.is_provisional,
  p5.close_5d_ago,
  p20.close_20d_ago,
  case when t.close is not null and p5.close_5d_ago is not null and p5.close_5d_ago > 0
    then ((t.close - p5.close_5d_ago) / p5.close_5d_ago) * 100
  end as pct_5d,
  case when t.close is not null and p20.close_20d_ago is not null and p20.close_20d_ago > 0
    then ((t.close - p20.close_20d_ago) / p20.close_20d_ago) * 100
  end as pct_20d
from public.industry_stocks i
left join today t on t.symbol = i.symbol
left join prev_5d p5 on p5.symbol = i.symbol
left join prev_20d p20 on p20.symbol = i.symbol;
