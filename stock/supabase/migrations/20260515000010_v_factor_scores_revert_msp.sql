-- M9.4c REVERT(行為回滾):v_factor_scores mom_count 改回 5 條(2026-05-16)
--
-- 原因:M9.4c(mom_strong_persist 第 6 動能)OOS 驗證證實惡化 —
--   top5 2025 OOS alpha +17.75 → +10.42(-7.33pp)、top5 2024 -22.08 →
--   -34.97(-12.89pp)。RSI≤75 上限把爆發性強勢名單(2492/3006 RSI>75)
--   相對降權,稀釋 top5 純度(已驗證的 alpha 來源)。Andy 拍板 revert。
--
-- 行為回滾做法(append-only,不動 cascade):
--   * mom_count_pos / mom_count_total 表達式改回 5 條(移除
--     mom_strong_persist 項)→ weighted_score 100% 回 Phase 0.7 基準
--   * mom_strong_persist 欄位「保留」在 price CTE + select 尾端(append-only
--     不可移除既有欄,且 v_stock_rank fs.* 依賴它)。computed 但不計分 =
--     無害 dead 欄。徹底清除 schema 需 drop cascade(風險高),Andy 選不做。
--
-- 驗證:L32 一致 + 4 個 backtest 必須 byte 回 Phase 0.7(2024 t10 -35.23/
--   t5 -22.08;2025 t10 +8.41/t5 +17.75)。score_universe_at 同步回 Step 0
--   (20260515000011)。v_price_factors/v_stock_rank 欄位留著、行為自動回。

create or replace view public.v_factor_scores as
with universe_symbols as (
  select symbol from public.v_price_factors
  union
  select symbol from public.v_chip_factors
),
settings as (
  select
    coalesce(
      (select value from public.app_settings where key = 'peg_threshold'),
      1.5::numeric  -- M9.3 預設 1.5(原 M9.1 1.2)
    ) as peg_threshold,
    coalesce(
      (select value from public.app_settings where key = 'roe_threshold'),
      10::numeric
    ) as roe_threshold
),
-- 基本面 7 條:從 v_stock_score 拿原值
fund as (
  select
    ss.symbol,
    case
      when ss.quarters_available is null or ss.quarters_available < 4 then null::int
      when ss.eps_pos_quarters >= 4 then 1
      else 0
    end as fund_eps_pos,
    case
      when ss.last_q_eps_yoy_pct is not null then case when ss.last_q_eps_yoy_pct > 0 then 1 else 0 end
      when ss.eps_yoy_pct is not null then case when ss.eps_yoy_pct > 0 then 1 else 0 end
      else null::int
    end as fund_eps_yoy,
    case
      when ss.roe_ttm is null then null::int
      when ss.roe_ttm > s.roe_threshold then 1 else 0
    end as fund_roe_high,
    case
      when ss.fcf_ttm is null then null::int
      when ss.fcf_ttm > 0 then 1 else 0
    end as fund_fcf_pos,
    case
      when ss.peg is null then null::int
      when ss.peg > 0 and ss.peg < s.peg_threshold then 1 else 0
    end as fund_peg_low,
    case
      when ss.latest_revenue_yoy_pct is null then null::int
      when ss.latest_revenue_yoy_pct > 0 then 1 else 0
    end as fund_rev_yoy,
    case
      when ss.gross_margin_yoy_pp is null then null::int
      when ss.gross_margin_yoy_pp > 0 then 1 else 0
    end as fund_gross_up
  from public.v_stock_score ss
  cross join settings s
),
-- 動能 5 + 反轉 2:從 v_price_factors 拿 boolean 轉 1/0(加 mom_above_ma200)
price as (
  select
    p.symbol,
    case when p.mom_ma_golden is null then null::int when p.mom_ma_golden then 1 else 0 end as mom_ma_golden,
    case when p.mom_ret_diff is null then null::int when p.mom_ret_diff then 1 else 0 end as mom_ret_diff,
    case when p.mom_rsi_strong is null then null::int when p.mom_rsi_strong then 1 else 0 end as mom_rsi_strong,
    case when p.mom_breakout is null then null::int when p.mom_breakout then 1 else 0 end as mom_breakout,
    case when p.mom_above_ma200 is null then null::int when p.mom_above_ma200 then 1 else 0 end as mom_above_ma200,  -- NEW (M9.3)
    case when p.mom_strong_persist is null then null::int when p.mom_strong_persist then 1 else 0 end as mom_strong_persist,  -- NEW (M9.4c)
    case when p.rev_off_high is null then null::int when p.rev_off_high then 1 else 0 end as rev_off_high,
    case when p.rev_vol_dry is null then null::int when p.rev_vol_dry then 1 else 0 end as rev_vol_dry,
    p.rsi14, p.off_high_60d_pct, p.ret_20d_pct, p.ret_60d_pct, p.ret_5d_pct,
    p.ma20_now, p.ma60_now, p.ma200_now, p.latest_close, p.latest_date,
    p.high_20d, p.vol_latest
  from public.v_price_factors p
),
-- 籌碼 5 條(不變)
chip as (
  select
    c.symbol,
    case when c.chip_foreign_3d_buy is null then null::int when c.chip_foreign_3d_buy then 1 else 0 end as chip_foreign_3d_buy,
    case when c.chip_margin_drop is null then null::int when c.chip_margin_drop then 1 else 0 end as chip_margin_drop,
    case when c.chip_lending_drop is null then null::int when c.chip_lending_drop then 1 else 0 end as chip_lending_drop,
    case when c.chip_share_concentrate is null then null::int when c.chip_share_concentrate then 1 else 0 end as chip_share_concentrate,
    case when c.chip_inst_concentration is null then null::int when c.chip_inst_concentration then 1 else 0 end as chip_inst_concentration,
    c.foreign_net_latest, c.foreign_net_3d_sum,
    c.margin_balance_latest, c.margin_delta_5d_sum,
    c.lending_latest, c.lending_prev,
    c.foreign_ratio_latest, c.foreign_ratio_prev,
    c.three_major_net_3d_sum, c.volume_3d_sum
  from public.v_chip_factors c
)
select
  u.symbol,
  -- 7 fund + 5 mom + 2 rev + 5 chip = 19 factor int 0/1/null
  fund.fund_eps_pos, fund.fund_eps_yoy, fund.fund_roe_high,
  fund.fund_fcf_pos, fund.fund_peg_low, fund.fund_rev_yoy, fund.fund_gross_up,
  price.mom_ma_golden, price.mom_ret_diff, price.mom_rsi_strong,
  price.mom_breakout, price.mom_above_ma200,
  price.rev_off_high, price.rev_vol_dry,
  chip.chip_foreign_3d_buy, chip.chip_margin_drop,
  chip.chip_lending_drop, chip.chip_share_concentrate, chip.chip_inst_concentration,
  -- 各維度 count_pos / count_total
  coalesce(case when fund.fund_eps_pos = 1 then 1 else 0 end, 0)
    + coalesce(case when fund.fund_eps_yoy = 1 then 1 else 0 end, 0)
    + coalesce(case when fund.fund_roe_high = 1 then 1 else 0 end, 0)
    + coalesce(case when fund.fund_fcf_pos = 1 then 1 else 0 end, 0)
    + coalesce(case when fund.fund_peg_low = 1 then 1 else 0 end, 0)
    + coalesce(case when fund.fund_rev_yoy = 1 then 1 else 0 end, 0)
    + coalesce(case when fund.fund_gross_up = 1 then 1 else 0 end, 0) as fund_count_pos,
  (case when fund.fund_eps_pos is not null then 1 else 0 end
    + case when fund.fund_eps_yoy is not null then 1 else 0 end
    + case when fund.fund_roe_high is not null then 1 else 0 end
    + case when fund.fund_fcf_pos is not null then 1 else 0 end
    + case when fund.fund_peg_low is not null then 1 else 0 end
    + case when fund.fund_rev_yoy is not null then 1 else 0 end
    + case when fund.fund_gross_up is not null then 1 else 0 end) as fund_count_total,
  -- 動能 5 條(REVERT:移除 mom_strong_persist 計分,回 Phase 0.7)
  coalesce(case when price.mom_ma_golden = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_ret_diff = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_rsi_strong = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_breakout = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_above_ma200 = 1 then 1 else 0 end, 0) as mom_count_pos,
  (case when price.mom_ma_golden is not null then 1 else 0 end
    + case when price.mom_ret_diff is not null then 1 else 0 end
    + case when price.mom_rsi_strong is not null then 1 else 0 end
    + case when price.mom_breakout is not null then 1 else 0 end
    + case when price.mom_above_ma200 is not null then 1 else 0 end) as mom_count_total,
  coalesce(case when price.rev_off_high = 1 then 1 else 0 end, 0)
    + coalesce(case when price.rev_vol_dry = 1 then 1 else 0 end, 0) as rev_count_pos,
  (case when price.rev_off_high is not null then 1 else 0 end
    + case when price.rev_vol_dry is not null then 1 else 0 end) as rev_count_total,
  coalesce(case when chip.chip_foreign_3d_buy = 1 then 1 else 0 end, 0)
    + coalesce(case when chip.chip_margin_drop = 1 then 1 else 0 end, 0)
    + coalesce(case when chip.chip_lending_drop = 1 then 1 else 0 end, 0)
    + coalesce(case when chip.chip_share_concentrate = 1 then 1 else 0 end, 0)
    + coalesce(case when chip.chip_inst_concentration = 1 then 1 else 0 end, 0) as chip_count_pos,
  (case when chip.chip_foreign_3d_buy is not null then 1 else 0 end
    + case when chip.chip_margin_drop is not null then 1 else 0 end
    + case when chip.chip_lending_drop is not null then 1 else 0 end
    + case when chip.chip_share_concentrate is not null then 1 else 0 end
    + case when chip.chip_inst_concentration is not null then 1 else 0 end) as chip_count_total,
  -- 輔助欄(雷達圖 + UI hover)
  price.rsi14, price.off_high_60d_pct, price.ret_20d_pct, price.ret_60d_pct, price.ret_5d_pct,
  price.ma20_now, price.ma60_now, price.ma200_now, price.latest_close, price.latest_date,
  price.high_20d, price.vol_latest,
  chip.foreign_net_latest, chip.foreign_net_3d_sum,
  chip.margin_balance_latest, chip.margin_delta_5d_sum,
  chip.lending_latest, chip.lending_prev,
  chip.foreign_ratio_latest, chip.foreign_ratio_prev,
  chip.three_major_net_3d_sum, chip.volume_3d_sum,
  -- M9.4c:append-only 尾欄(雷達圖第 20 軸)
  price.mom_strong_persist
from universe_symbols u
left join fund on fund.symbol = u.symbol
left join price on price.symbol = u.symbol
left join chip on chip.symbol = u.symbol;

comment on view public.v_factor_scores is
  'M9.4c REVERT:計分回 19 條(7 fund + 5 mom + 2 rev + 5 chip)。
   mom_strong_persist 欄保留但不計分(append-only dead 欄,OOS 證實惡化)。
   PEG / ROE 從 app_settings 拿(peg_threshold 預設 1.5,roe_threshold 預設 10)。';
