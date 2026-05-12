-- M9: 動能 / 反轉因子(全從 price_daily 算)
--
-- 範圍管理(L01):只覆蓋 universe_symbols = stock_universe ∪ industry_stocks ∪ holdings ∪ watchlist ∪ etf_metadata
--   不掃 price_daily 全表(免費 API 後續會把 ~200 檔餵滿,這集合即等同於 fetcher 目標)
--
-- 5 個 boolean factor + 6 個輔助欄位(MA20/MA60/RSI14/60d_high/pct_20d/pct_60d)供雷達圖 & UI 顯示
--
-- 設計細節:
-- 1. MA20 / MA60:以「最新交易日」為錨點,各往前 20 / 60 個交易日的 close 平均
--    用 window function 在 ranked 上算,partition by symbol
-- 2. RSI14:14 日內 avg(gain) / avg(loss) 經典 SMA-RSI(非 Wilder 平滑版,夠用)
-- 3. mom_ma_golden:latest MA20 > latest MA60 AND 5 天前 MA20 ≤ MA60(近期 crossover)
-- 4. mom_ret_diff:20 日報酬 > 60 日報酬 / 20(代表近 20 日明顯加速)
-- 5. mom_rsi_ok:RSI14 < 70(沒過熱)
-- 6. rev_off_high:(60d high - latest) / 60d high > 10%
-- 7. rev_vol_dry:5 日跌幅 > 3% AND 5 日 avg volume < 過去 20 日 avg volume × 0.85(明顯量縮)

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
-- 撈過去 ~100 個交易日的 OHLCV,給 60 日 MA + 5 日緩衝
ranked as (
  select
    p.symbol, p.trade_date, p.close, p.volume,
    row_number() over (partition by p.symbol order by p.trade_date desc) as rn,
    -- daily return for RSI (close vs prev close)
    p.close - lag(p.close) over (partition by p.symbol order by p.trade_date) as price_change
  from public.price_daily p
  inner join universe_symbols u on u.symbol = p.symbol
  where p.trade_date >= current_date - interval '180 days'
),
agg as (
  select
    symbol,
    -- 最新 close & date
    max(case when rn = 1 then close end) as latest_close,
    max(case when rn = 1 then trade_date end) as latest_date,
    -- 20 日前 & 60 日前 close
    max(case when rn = 21 then close end) as close_20d_ago,
    max(case when rn = 61 then close end) as close_60d_ago,
    max(case when rn = 6 then close end) as close_5d_ago,
    -- MA20 = avg(rn 1..20),MA60 = avg(rn 1..60)
    avg(case when rn between 1 and 20 then close end) as ma20_now,
    avg(case when rn between 1 and 60 then close end) as ma60_now,
    -- 5 天前的 MA20 / MA60(rn 6..25 / 6..65)
    avg(case when rn between 6 and 25 then close end) as ma20_prev,
    avg(case when rn between 6 and 65 then close end) as ma60_prev,
    -- 60 日高點
    max(case when rn between 1 and 60 then close end) as high_60d,
    -- 成交量:近 5 日 avg vs 過去 20 日 avg
    avg(case when rn between 1 and 5 then volume end) as vol_5d_avg,
    avg(case when rn between 1 and 20 then volume end) as vol_20d_avg,
    -- RSI14 components(rn 1..14 的 gain/loss)
    sum(case when rn between 1 and 14 and price_change > 0 then price_change else 0 end) as gain_14,
    sum(case when rn between 1 and 14 and price_change < 0 then -price_change else 0 end) as loss_14,
    -- 資料量保護:RSI 需要 ≥ 14 天 close 才有意義(price_change 第一天為 null 不計)
    count(case when rn between 1 and 14 and price_change is not null then 1 end) as rsi_days_available,
    -- MA60 需要 ≥ 60 天才算
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
  -- RSI14 = 100 - 100/(1+RS),RS = avg_gain / avg_loss(需 ≥ 13 個非 null daily return)
  case
    when a.rsi_days_available is null or a.rsi_days_available < 13 then null
    when a.loss_14 = 0 and a.gain_14 = 0 then 50  -- 全 flat = 中性
    when a.loss_14 = 0 then 100                    -- 純漲 = 極端超買
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
  -- ============ Factor 1:MA20/MA60 黃金交叉 ============
  -- 現在 MA20 > MA60 且 5 天前 MA20 <= MA60(近期才剛 crossover)
  -- 需 MA60 樣本 ≥ 60 天(否則 MA60 不可靠)
  case
    when a.ma60_days_available is null or a.ma60_days_available < 60 then null::boolean
    when a.ma20_now is null or a.ma60_now is null or a.ma20_prev is null or a.ma60_prev is null
      then null::boolean
    else (a.ma20_now > a.ma60_now and a.ma20_prev <= a.ma60_prev)
  end as mom_ma_golden,
  -- ============ Factor 2:20 日報酬 > 60 日報酬(動能加速)============
  -- 條件:ret_20d > 0 AND ret_20d > ret_60d / 3(20 日 = 60 日的 1/3,所以 1/3 是均等動能)
  case
    when a.close_20d_ago is null or a.close_60d_ago is null
      or a.close_20d_ago <= 0 or a.close_60d_ago <= 0
      then null::boolean
    else (((a.latest_close - a.close_20d_ago) / a.close_20d_ago) > 0
          and ((a.latest_close - a.close_20d_ago) / a.close_20d_ago)
              > ((a.latest_close - a.close_60d_ago) / a.close_60d_ago) / 3)
  end as mom_ret_diff,
  -- ============ Factor 3:RSI14 不在超買區(<70)============
  case
    when a.rsi_days_available is null or a.rsi_days_available < 13 then null::boolean
    when a.loss_14 = 0 and a.gain_14 = 0 then true  -- flat ok
    when a.loss_14 = 0 then false                    -- RSI=100
    else (100 - (100.0 / (1 + (a.gain_14 / a.loss_14)))) < 70
  end as mom_rsi_ok,
  -- ============ Factor 4:距 60 日高點折價 > 10%(深蹲)============
  case
    when a.ma60_days_available is null or a.ma60_days_available < 60 then null::boolean
    when a.high_60d is null or a.high_60d <= 0 or a.latest_close is null then null::boolean
    else ((a.high_60d - a.latest_close) / a.high_60d) > 0.10
  end as rev_off_high,
  -- ============ Factor 5:5 日跌幅 > 3% 且量縮 ============
  -- 條件:ret_5d < -3% AND vol_5d_avg < vol_20d_avg × 0.85(量縮 15%+)
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
  'M9 動能 + 反轉因子(全從 price_daily 算,基於 universe ∪ industry ∪ holdings ∪ watchlist ∪ etf)。
   5 個 boolean factor(mom_ma_golden / mom_ret_diff / mom_rsi_ok / rev_off_high / rev_vol_dry)
   + 輔助欄位(rsi14 / off_high_60d_pct / ret_20d_pct / ret_60d_pct 等)供 v_factor_scores 與 UI 雷達圖用。';
