-- M9.1: v_price_factors v2 — RSI factor 改邏輯
--
-- 變動:
--   mom_rsi_ok(RSI14 < 70,「不超買」)
--     → mom_rsi_strong(RSI14 > 50,「轉強訊號」)
--
-- 為什麼:
--   <70 是「不超買」(避錯誤),屬於風控過濾條件,但對「進場 timing」不夠主動 —
--   多頭強股 RSI 一般在 50~70 都正常運行,要的是「站上 50 轉強」這個 momentum trigger。
--   台股實證:RSI 50 是多空分水嶺,>50 表示近 14 日 gain 多於 loss,屬 momentum confirm。
--
-- 其他 factor 保留不變(mom_ma_golden / mom_ret_diff / rev_off_high / rev_vol_dry)。

drop view if exists public.v_price_factors cascade;

create view public.v_price_factors as
with universe_symbols as (
  select symbol from public.stock_universe
  union
  select symbol from public.industry_stocks
  union
  select symbol from public.watchlist
  union
  select symbol from public.holdings_transactions
  union
  select symbol from public.etf_metadata
),
ranked as (
  select
    p.symbol, p.trade_date, p.close, p.volume,
    row_number() over (partition by p.symbol order by p.trade_date desc) as rn,
    p.close - lag(p.close) over (partition by p.symbol order by p.trade_date) as price_change
  from public.price_daily p
  inner join universe_symbols u on u.symbol = p.symbol
  where p.trade_date >= current_date - interval '180 days'
),
agg as (
  select
    symbol,
    max(case when rn = 1 then close end) as latest_close,
    max(case when rn = 1 then trade_date end) as latest_date,
    max(case when rn = 21 then close end) as close_20d_ago,
    max(case when rn = 61 then close end) as close_60d_ago,
    max(case when rn = 6 then close end) as close_5d_ago,
    avg(case when rn between 1 and 20 then close end) as ma20_now,
    avg(case when rn between 1 and 60 then close end) as ma60_now,
    avg(case when rn between 6 and 25 then close end) as ma20_prev,
    avg(case when rn between 6 and 65 then close end) as ma60_prev,
    max(case when rn between 1 and 60 then close end) as high_60d,
    avg(case when rn between 1 and 5 then volume end) as vol_5d_avg,
    avg(case when rn between 1 and 20 then volume end) as vol_20d_avg,
    sum(case when rn between 1 and 14 and price_change > 0 then price_change else 0 end) as gain_14,
    sum(case when rn between 1 and 14 and price_change < 0 then -price_change else 0 end) as loss_14,
    count(case when rn between 1 and 14 and price_change is not null then 1 end) as rsi_days_available,
    count(case when rn between 1 and 60 then 1 end) as ma60_days_available
  from ranked
  group by symbol
)
select
  a.symbol,
  a.latest_close,
  a.latest_date,
  a.ma20_now,
  a.ma60_now,
  case
    when a.rsi_days_available is null or a.rsi_days_available < 13 then null
    when a.loss_14 = 0 and a.gain_14 = 0 then 50  -- flat = 中性 50
    when a.loss_14 = 0 then 100                    -- 純漲
    else 100 - (100.0 / (1 + (a.gain_14 / a.loss_14)))
  end as rsi14,
  a.high_60d,
  case when a.high_60d is not null and a.high_60d > 0
    then ((a.high_60d - a.latest_close) / a.high_60d) * 100 end as off_high_60d_pct,
  case when a.close_20d_ago is not null and a.close_20d_ago > 0
    then ((a.latest_close - a.close_20d_ago) / a.close_20d_ago) * 100 end as ret_20d_pct,
  case when a.close_60d_ago is not null and a.close_60d_ago > 0
    then ((a.latest_close - a.close_60d_ago) / a.close_60d_ago) * 100 end as ret_60d_pct,
  case when a.close_5d_ago is not null and a.close_5d_ago > 0
    then ((a.latest_close - a.close_5d_ago) / a.close_5d_ago) * 100 end as ret_5d_pct,
  a.vol_5d_avg,
  a.vol_20d_avg,
  -- ============ Factor 1:MA20/MA60 黃金交叉(不變)============
  case
    when a.ma60_days_available is null or a.ma60_days_available < 60 then null::boolean
    when a.ma20_now is null or a.ma60_now is null or a.ma20_prev is null or a.ma60_prev is null
      then null::boolean
    else (a.ma20_now > a.ma60_now and a.ma20_prev <= a.ma60_prev)
  end as mom_ma_golden,
  -- ============ Factor 2:20 日報酬 vs 60 日報酬(動能加速,不變)============
  case
    when a.close_20d_ago is null or a.close_60d_ago is null
      or a.close_20d_ago <= 0 or a.close_60d_ago <= 0
      then null::boolean
    else (((a.latest_close - a.close_20d_ago) / a.close_20d_ago) > 0
          and ((a.latest_close - a.close_20d_ago) / a.close_20d_ago)
              > ((a.latest_close - a.close_60d_ago) / a.close_60d_ago) / 3)
  end as mom_ret_diff,
  -- ============ Factor 3:RSI14 > 50(轉強,從 v1 < 70 改邏輯)============
  case
    when a.rsi_days_available is null or a.rsi_days_available < 13 then null::boolean
    when a.loss_14 = 0 and a.gain_14 = 0 then false   -- flat,沒有轉強
    when a.loss_14 = 0 then true                       -- 純漲 RSI=100,確實轉強
    else (100 - (100.0 / (1 + (a.gain_14 / a.loss_14)))) > 50
  end as mom_rsi_strong,
  -- ============ Factor 4:距 60 日高點折價 > 10%(深蹲,不變)============
  case
    when a.ma60_days_available is null or a.ma60_days_available < 60 then null::boolean
    when a.high_60d is null or a.high_60d <= 0 or a.latest_close is null then null::boolean
    else ((a.high_60d - a.latest_close) / a.high_60d) > 0.10
  end as rev_off_high,
  -- ============ Factor 5:5 日跌幅 > 3% 且量縮(不變)============
  case
    when a.close_5d_ago is null or a.close_5d_ago <= 0
      or a.vol_5d_avg is null or a.vol_20d_avg is null or a.vol_20d_avg = 0
      then null::boolean
    else (((a.latest_close - a.close_5d_ago) / a.close_5d_ago) * 100 < -3
          and a.vol_5d_avg < a.vol_20d_avg * 0.85)
  end as rev_vol_dry
from agg a
where a.latest_close is not null;

comment on view public.v_price_factors is
  'M9.1 動能 + 反轉因子 v2:RSI factor 改為 mom_rsi_strong(RSI>50,轉強)。
   其他 factor 不變(mom_ma_golden / mom_ret_diff / rev_off_high / rev_vol_dry)。';
