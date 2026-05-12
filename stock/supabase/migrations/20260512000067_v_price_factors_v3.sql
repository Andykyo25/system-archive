-- M9.2: v_price_factors v3 — 加 mom_breakout 因子(突破 + 放量)
--
-- 新 factor:mom_breakout
--   條件:
--     (1) latest_close >= high_20d * 0.99  -- 接近或突破 20 日新高(留 1% buffer)
--     (2) vol_latest > vol_5d_avg * 2       -- 當日量 > 5 日均量 × 2(放量突破)
--
-- 為什麼:
--   v1/v2 的動能 factor(mom_ma_golden / mom_ret_diff / mom_rsi_strong)抓不到「漲停飆股」
--   特性。例:華新科 2492 5/11+5/12 連 2 根漲停 +36%,但因 MA20 在 MA60 上一直沒「剛交叉」,
--   mom_ma_golden=false。
--   突破因子直接看「接近 20 日高點 + 放量」這個 momentum trigger。
--
-- 為什麼 0.99 buffer:
--   漲停股 high 噴到接近上限,close 常略低於 high(open/盤中觸 high → 拉回收盤)。
--   要 close >= high_20d × 1.0 太嚴格,容易漏掉「漲停打到 20 日新高但收盤 -1% 拉回」。
--   0.99 等於放寬 1%,實務上漲停股都會過。
--
-- 為什麼 2 倍量:
--   1.5 倍太常見(平常交易日波動就會出現),3 倍太嚴格。
--   2 倍是「明顯放量」的標準(學術 factor research 常用 1.5-3x range,2x 是中位)。
--
-- 資料量保護(L23):
--   high_20d / vol_latest / vol_5d_avg 任一 null → factor null(不汙染 count_total)
--   需要 ranked 至少 1 個 row(vol_latest)+ 20 日資料(high_20d)+ 5 日均量(vol_5d_avg 已存在)
--
-- 其他 factor 不變(mom_ma_golden / mom_ret_diff / mom_rsi_strong / rev_off_high / rev_vol_dry)。

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
    max(case when rn = 1 then volume end) as vol_latest,  -- NEW(M9.2):當日量
    max(case when rn = 21 then close end) as close_20d_ago,
    max(case when rn = 61 then close end) as close_60d_ago,
    max(case when rn = 6 then close end) as close_5d_ago,
    avg(case when rn between 1 and 20 then close end) as ma20_now,
    avg(case when rn between 1 and 60 then close end) as ma60_now,
    avg(case when rn between 6 and 25 then close end) as ma20_prev,
    avg(case when rn between 6 and 65 then close end) as ma60_prev,
    max(case when rn between 1 and 60 then close end) as high_60d,
    max(case when rn between 1 and 20 then close end) as high_20d,  -- NEW(M9.2):20 日新高
    avg(case when rn between 1 and 5 then volume end) as vol_5d_avg,
    avg(case when rn between 1 and 20 then volume end) as vol_20d_avg,
    sum(case when rn between 1 and 14 and price_change > 0 then price_change else 0 end) as gain_14,
    sum(case when rn between 1 and 14 and price_change < 0 then -price_change else 0 end) as loss_14,
    count(case when rn between 1 and 14 and price_change is not null then 1 end) as rsi_days_available,
    count(case when rn between 1 and 60 then 1 end) as ma60_days_available,
    count(case when rn between 1 and 20 then 1 end) as ma20_days_available
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
  -- ============ Factor 4 (NEW M9.2):突破因子(20 日新高 + 放量 2x)============
  case
    when a.ma20_days_available is null or a.ma20_days_available < 20 then null::boolean
    when a.high_20d is null or a.vol_latest is null
      or a.vol_5d_avg is null or a.vol_5d_avg = 0 then null::boolean
    else (a.latest_close >= a.high_20d * 0.99
          and a.vol_latest > a.vol_5d_avg * 2)
  end as mom_breakout,
  -- ============ Factor 5:距 60 日高點折價 > 10%(深蹲,不變)============
  case
    when a.ma60_days_available is null or a.ma60_days_available < 60 then null::boolean
    when a.high_60d is null or a.high_60d <= 0 or a.latest_close is null then null::boolean
    else ((a.high_60d - a.latest_close) / a.high_60d) > 0.10
  end as rev_off_high,
  -- ============ Factor 6:5 日跌幅 > 3% 且量縮(不變)============
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
  'M9.2 動能 + 反轉因子 v3:加 mom_breakout(20 日新高 close >= high_20d × 0.99 + 當日量 > 5 日均量 × 2)。
   其他 factor 不變(mom_ma_golden / mom_ret_diff / mom_rsi_strong / rev_off_high / rev_vol_dry)。';
