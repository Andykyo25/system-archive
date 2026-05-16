-- M9.4c 階段 3 Step 1:v_price_factors 加第 6 個動能 factor mom_strong_persist(2026-05-16)
--
-- 目的:補捉 TSMC 類「持續強勢、走高但未爆量突破」標的(現有 mom_breakout
--   需放量 2x 會漏掉穩步走高的)。Andy 確認定義(原版):
--   ret_60d>0 AND latest_close>ma20_now AND RSI14 介於 50~75。
--   日數保護(L23):RSI≥13、MA20≥20、需 60d 前價且 >0。
--   RSI 上限 75 避免追過熱;下限 50 確認轉強。RSI 算式鏡像本 view rsi14。
--
-- 變更方式:append-only CREATE OR REPLACE — mom_strong_persist 加在 select
--   最尾端(rev_vol_dry 之後),既有欄位名稱/型別/順序全不動 → Postgres
--   允許、完全避開 cascade(v_factor_scores/v_stock_rank/v_holdings_advice
--   /Telegram/rank 全程不破)。0.5 的 close*adj_factor 維持不動。
--
-- L32:score_universe_at 必須同步加同一 factor(見 20260515000009)。
-- 連鎖:mom 動能總數 5→6,v_factor_scores mom_count、v_stock_rank 加權同步。
-- 同步:score_universe_at 必須一起改(L32 鐵律,見 20260515000003)。
-- 連鎖:v_factor_scores → v_stock_rank → v_entry_signal → /rank /holdings。

create or replace view public.v_price_factors as
with universe_symbols as (
  select symbol from public.stock_universe
  union select symbol from public.industry_stocks
  union select symbol from public.watchlist
  union select symbol from public.holdings_transactions
  union select symbol from public.etf_metadata
),
ranked as (
  select p.symbol, p.trade_date,
    p.close * p.adj_factor as close,
    p.volume,
    row_number() over (partition by p.symbol order by p.trade_date desc) as rn,
    (p.close * p.adj_factor)
      - lag(p.close * p.adj_factor) over (partition by p.symbol order by p.trade_date)
      as price_change
  from public.price_daily p
  inner join universe_symbols u on u.symbol = p.symbol
  where p.trade_date >= current_date - interval '320 days'
),
agg as (
  select symbol,
    max(case when rn = 1 then close end) as latest_close,
    max(case when rn = 1 then trade_date end) as latest_date,
    max(case when rn = 1 then volume end) as vol_latest,
    max(case when rn = 21 then close end) as close_20d_ago,
    max(case when rn = 61 then close end) as close_60d_ago,
    max(case when rn = 6 then close end) as close_5d_ago,
    avg(case when rn between 1 and 20 then close end) as ma20_now,
    avg(case when rn between 1 and 60 then close end) as ma60_now,
    avg(case when rn between 1 and 200 then close end) as ma200_now,
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
    count(case when rn between 1 and 200 then 1 end) as ma200_days_available
  from ranked group by symbol
)
select a.symbol, a.latest_close, a.latest_date, a.ma20_now, a.ma60_now, a.ma200_now,
  case when a.rsi_days_available is null or a.rsi_days_available < 13 then null
    when a.loss_14 = 0 and a.gain_14 = 0 then 50
    when a.loss_14 = 0 then 100
    else 100 - (100.0 / (1 + (a.gain_14 / a.loss_14)))
  end as rsi14,
  a.high_60d, a.high_20d, a.vol_latest,
  case when a.high_60d is not null and a.high_60d > 0
    then ((a.high_60d - a.latest_close) / a.high_60d) * 100 end as off_high_60d_pct,
  case when a.close_20d_ago is not null and a.close_20d_ago > 0
    then ((a.latest_close - a.close_20d_ago) / a.close_20d_ago) * 100 end as ret_20d_pct,
  case when a.close_60d_ago is not null and a.close_60d_ago > 0
    then ((a.latest_close - a.close_60d_ago) / a.close_60d_ago) * 100 end as ret_60d_pct,
  case when a.close_5d_ago is not null and a.close_5d_ago > 0
    then ((a.latest_close - a.close_5d_ago) / a.close_5d_ago) * 100 end as ret_5d_pct,
  a.vol_5d_avg, a.vol_20d_avg,
  case when a.ma60_days_available is null or a.ma60_days_available < 60 then null::boolean
    when a.ma20_now is null or a.ma60_now is null or a.ma20_prev is null or a.ma60_prev is null then null::boolean
    else (a.ma20_now > a.ma60_now and a.ma20_prev <= a.ma60_prev)
  end as mom_ma_golden,
  case when a.close_20d_ago is null or a.close_60d_ago is null
    or a.close_20d_ago <= 0 or a.close_60d_ago <= 0 then null::boolean
    else (((a.latest_close - a.close_20d_ago) / a.close_20d_ago) > 0
          and ((a.latest_close - a.close_20d_ago) / a.close_20d_ago)
              > ((a.latest_close - a.close_60d_ago) / a.close_60d_ago) / 3)
  end as mom_ret_diff,
  case when a.rsi_days_available is null or a.rsi_days_available < 13 then null::boolean
    when a.loss_14 = 0 and a.gain_14 = 0 then false
    when a.loss_14 = 0 then true
    else (100 - (100.0 / (1 + (a.gain_14 / a.loss_14)))) > 50
  end as mom_rsi_strong,
  case when a.ma20_days_available is null or a.ma20_days_available < 20 then null::boolean
    when a.high_20d is null or a.vol_latest is null
      or a.vol_5d_avg is null or a.vol_5d_avg = 0 then null::boolean
    else (a.latest_close >= a.high_20d * 0.99 and a.vol_latest > a.vol_5d_avg * 2)
  end as mom_breakout,
  case when a.ma200_days_available is null or a.ma200_days_available < 180 then null::boolean
    when a.ma200_now is null or a.latest_close is null or a.close_60d_ago is null
      or a.close_60d_ago <= 0 then null::boolean
    else (a.latest_close > a.ma200_now
          and ((a.latest_close - a.close_60d_ago) / a.close_60d_ago) > 0)
  end as mom_above_ma200,
  case when a.ma60_days_available is null or a.ma60_days_available < 60 then null::boolean
    when a.high_60d is null or a.high_60d <= 0 or a.latest_close is null then null::boolean
    else ((a.high_60d - a.latest_close) / a.high_60d) > 0.10
  end as rev_off_high,
  case when a.close_5d_ago is null or a.close_5d_ago <= 0
    or a.vol_5d_avg is null or a.vol_20d_avg is null or a.vol_20d_avg = 0 then null::boolean
    else (((a.latest_close - a.close_5d_ago) / a.close_5d_ago) * 100 < -3
          and a.vol_5d_avg < a.vol_20d_avg * 0.85)
  end as rev_vol_dry,
  -- M9.4c:持續強勢(ret_60d>0 + close>MA20 + RSI14 50~75)。append-only 尾欄。
  case
    when a.rsi_days_available is null or a.rsi_days_available < 13 then null::boolean
    when a.ma20_days_available is null or a.ma20_days_available < 20 then null::boolean
    when a.close_60d_ago is null or a.close_60d_ago <= 0
      or a.latest_close is null or a.ma20_now is null then null::boolean
    else (
      ((a.latest_close - a.close_60d_ago) / a.close_60d_ago) > 0
      and a.latest_close > a.ma20_now
      and (case
             when a.loss_14 = 0 and a.gain_14 = 0 then 50
             when a.loss_14 = 0 then 100
             else 100 - (100.0 / (1 + (a.gain_14 / a.loss_14)))
           end) between 50 and 75
    )
  end as mom_strong_persist
from agg a where a.latest_close is not null;
