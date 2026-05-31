-- A2(全系統審查):v_price_factors.mom_ret_diff 加 ret_60d>0 gate(2026-06-01)
--
-- 起因:mom_ret_diff 原式 = ret_20d>0 AND ret_20d > ret_60d/3。
--   當 ret_60d<0 時,ret_60d/3 變成負門檻,任何「長期跌、近期反彈」的
--   跌深反彈股(ret_20d>0)都輕鬆 > 負門檻 → 被誤判為「動能加速」。
--   實測 93 檔 mom_ret_diff=TRUE 中 20 檔是這種假動能(ret_60d<0),
--   3596(ret60 -1.2% / ret20 +17.9%)甚至排進 expected_rank=5(top5)。
--   航運股(2609/2610/2612/2615)整群是受害類型。
--
-- 修法:加 ret_60d>0 gate。意圖本就是「短期動能 > 長期動能斜率『且皆正』」
--   = 真正的加速上漲,而非跌深反彈。
--
-- 連動:v_factor_scores 讀本 view 的 mom_ret_diff(boolean)→ 自動傳導到
--   v_stock_rank → v_holdings_advice → /rank /holdings / Telegram。
--   L32 鐵律:score_universe_at(回測)必須同步同一 gate(見 20260601000002),
--   否則破壞「回測=線上」一致性。
--
-- 影響:mom_count 對那 20 檔少 1 → weighted_score 微降 → expected_rank 重排。
--   這是「移除污染」的正確改變(跌深反彈不該算動能)。
--
-- 變更方式:append-only CREATE OR REPLACE,欄位名稱/型別/順序全不動,
--   僅 mom_ret_diff case 內多一個 AND 條件。base = 20260515000006 逐字。

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
          and ((a.latest_close - a.close_60d_ago) / a.close_60d_ago) > 0  -- A2:加 ret_60d>0 gate(排除跌深反彈假動能)
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
