-- M9.3: v_price_factors v4 — 加 mom_above_ma200(長期趨勢向上)
--
-- 新 factor:mom_above_ma200
--   條件:
--     (1) 60 日報酬 > 0%
--     (2) latest_close > MA200
--
-- 為什麼:
--   v3 動能 4 條(ma_golden / ret_diff / rsi_strong / breakout)抓不到「續強龍頭」。
--   例:TSMC 2024 上半年漲幅 +50%,但 MA20/MA60 早就在均線上,黃金交叉不會發生
--   (mom_ma_golden=false 永遠);RSI14 也常在 60-70 區間,RSI>50 雖過,但這只是
--   「轉強」不是「持續強勢」。要抓「長期趨勢向上」的續強股,需要 MA200 維度。
--
-- 為什麼要兩個條件:
--   單看 close > MA200 不夠 — 有可能股價剛突破 200 日線但 60 日報酬還是負(剛從低點反彈)。
--   加上 60 日報酬 > 0 才確保「中期 + 長期同步向上」。
--
-- 資料量保護(L23):
--   ma200_days_available < 180 → factor null(0.9 × 200,放寬給新上市股 ~9 個月歷史)
--   close_60d_ago / ma200_now / latest_close 任一 null → factor null
--
-- 其他 factor 不變(mom_ma_golden / mom_ret_diff / mom_rsi_strong / mom_breakout /
--                  rev_off_high / rev_vol_dry)。
--
-- ranked CTE 視窗從 180 天 → 220 天(MA200 需要 200 個交易日歷史)

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
  where p.trade_date >= current_date - interval '220 days'  -- M9.3:擴大視窗給 MA200
),
agg as (
  select
    symbol,
    max(case when rn = 1 then close end) as latest_close,
    max(case when rn = 1 then trade_date end) as latest_date,
    max(case when rn = 1 then volume end) as vol_latest,
    max(case when rn = 21 then close end) as close_20d_ago,
    max(case when rn = 61 then close end) as close_60d_ago,
    max(case when rn = 6 then close end) as close_5d_ago,
    avg(case when rn between 1 and 20 then close end) as ma20_now,
    avg(case when rn between 1 and 60 then close end) as ma60_now,
    avg(case when rn between 1 and 200 then close end) as ma200_now,  -- NEW (M9.3)
    avg(case when rn between 6 and 25 then close end) as ma20_prev,
    avg(case when rn between 6 and 65 then close end) as ma60_prev,
    max(case when rn between 1 and 60 then close end) as high_60d,
    max(case when rn between 1 and 20 then close end) as high_20d,
    avg(case when rn between 1 and 5 then volume end) as vol_5d_avg,
    avg(case when rn between 1 and 20 then volume end) as vol_20d_avg,
    sum(case when rn between 1 and 14 and price_change > 0 then price_change else 0 end) as gain_14,
    sum(case when rn between 1 and 14 and price_change < 0 then -price_change else 0 end) as loss_14,
    count(case when rn between 1 and 14 and price_change is not null then 1 end) as rsi_days_available,
    count(case when rn between 1 and 60 then 1 end) as ma60_days_available,
    count(case when rn between 1 and 20 then 1 end) as ma20_days_available,
    count(case when rn between 1 and 200 then 1 end) as ma200_days_available  -- NEW (M9.3)
  from ranked
  group by symbol
)
select
  a.symbol,
  a.latest_close,
  a.latest_date,
  a.ma20_now,
  a.ma60_now,
  a.ma200_now,  -- NEW (M9.3) 輔助欄
  case
    when a.rsi_days_available is null or a.rsi_days_available < 13 then null
    when a.loss_14 = 0 and a.gain_14 = 0 then 50  -- flat = 中性 50
    when a.loss_14 = 0 then 100                    -- 純漲
    else 100 - (100.0 / (1 + (a.gain_14 / a.loss_14)))
  end as rsi14,
  a.high_60d,
  a.high_20d,
  a.vol_latest,
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
  -- ============ Factor 3:RSI14 > 50(轉強,不變)============
  case
    when a.rsi_days_available is null or a.rsi_days_available < 13 then null::boolean
    when a.loss_14 = 0 and a.gain_14 = 0 then false   -- flat,沒有轉強
    when a.loss_14 = 0 then true                       -- 純漲 RSI=100,確實轉強
    else (100 - (100.0 / (1 + (a.gain_14 / a.loss_14)))) > 50
  end as mom_rsi_strong,
  -- ============ Factor 4:突破因子(20 日新高 + 放量 2x,不變)============
  case
    when a.ma20_days_available is null or a.ma20_days_available < 20 then null::boolean
    when a.high_20d is null or a.vol_latest is null
      or a.vol_5d_avg is null or a.vol_5d_avg = 0 then null::boolean
    else (a.latest_close >= a.high_20d * 0.99
          and a.vol_latest > a.vol_5d_avg * 2)
  end as mom_breakout,
  -- ============ Factor 5 (NEW M9.3):站上 MA200 + 60 日報酬正(長期趨勢續強)============
  case
    when a.ma200_days_available is null or a.ma200_days_available < 180 then null::boolean
    when a.ma200_now is null or a.latest_close is null or a.close_60d_ago is null
      or a.close_60d_ago <= 0 then null::boolean
    else (a.latest_close > a.ma200_now
          and ((a.latest_close - a.close_60d_ago) / a.close_60d_ago) > 0)
  end as mom_above_ma200,
  -- ============ Factor 6:距 60 日高點折價 > 10%(深蹲,不變)============
  case
    when a.ma60_days_available is null or a.ma60_days_available < 60 then null::boolean
    when a.high_60d is null or a.high_60d <= 0 or a.latest_close is null then null::boolean
    else ((a.high_60d - a.latest_close) / a.high_60d) > 0.10
  end as rev_off_high,
  -- ============ Factor 7:5 日跌幅 > 3% 且量縮(不變)============
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
  'M9.3 動能 + 反轉因子 v4:加 mom_above_ma200(60d ret > 0 AND close > MA200,需 ≥ 180 日歷史)。
   動能 5 條(ma_golden / ret_diff / rsi_strong / breakout / above_ma200)。';
