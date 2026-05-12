-- M9.2: v_factor_scores v3 — 7 fund + 4 mom + 2 rev + 5 chip = 18 factor
--
-- 變動:
--   * 動能 3 → 4 條:加 mom_breakout(v_price_factors v3 已加)
--   * 基本面 ROE factor 改用 app_settings.roe_threshold(預設 10)
--   * count_pos / count_total 動能 3 → 4 對應
--   * 17 → 18 factor 全 pass-through
--
-- 基本面 7 條(其他不變):
--   fund_roe_high 從 hardcode 15 → app_settings.roe_threshold(預設 10)
-- 動能 4 條(加 mom_breakout):
--   mom_ma_golden / mom_ret_diff / mom_rsi_strong / mom_breakout
-- 反轉 2 條(不變):rev_off_high / rev_vol_dry
-- 籌碼 5 條(不變):chip_foreign_3d_buy / chip_margin_drop / chip_lending_drop /
--                  chip_share_concentrate / chip_inst_concentration

drop view if exists public.v_factor_scores cascade;

create view public.v_factor_scores as
with universe_symbols as (
  select symbol from public.v_price_factors
  union
  select symbol from public.v_chip_factors
),
settings as (
  select
    coalesce(
      (select value from public.app_settings where key = 'peg_threshold'),
      1.2::numeric
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
    -- f1:過去 4 季 EPS 皆 > 0
    case
      when ss.quarters_available is null or ss.quarters_available < 4 then null::int
      when ss.eps_pos_quarters >= 4 then 1
      else 0
    end as fund_eps_pos,
    -- f2:EPS YoY > 0
    case
      when ss.last_q_eps_yoy_pct is not null then case when ss.last_q_eps_yoy_pct > 0 then 1 else 0 end
      when ss.eps_yoy_pct is not null then case when ss.eps_yoy_pct > 0 then 1 else 0 end
      else null::int
    end as fund_eps_yoy,
    -- f3:ROE > roe_threshold(settings,M9.2 預設 10,原 M9.1 是 hardcode 15)
    case
      when ss.roe_ttm is null then null::int
      when ss.roe_ttm > s.roe_threshold then 1 else 0
    end as fund_roe_high,
    -- f4:FCF > 0
    case
      when ss.fcf_ttm is null then null::int
      when ss.fcf_ttm > 0 then 1 else 0
    end as fund_fcf_pos,
    -- f5:PEG < peg_threshold(settings 預設 1.2)
    case
      when ss.peg is null then null::int
      when ss.peg > 0 and ss.peg < s.peg_threshold then 1 else 0
    end as fund_peg_low,
    -- f6:月營收 YoY > 0
    case
      when ss.latest_revenue_yoy_pct is null then null::int
      when ss.latest_revenue_yoy_pct > 0 then 1 else 0
    end as fund_rev_yoy,
    -- f7:毛利率 YoY 上升(三率升 proxy)
    case
      when ss.gross_margin_yoy_pp is null then null::int
      when ss.gross_margin_yoy_pp > 0 then 1 else 0
    end as fund_gross_up
  from public.v_stock_score ss
  cross join settings s
),
-- 動能 4 + 反轉 2:從 v_price_factors 拿 boolean 轉 1/0(加 mom_breakout)
price as (
  select
    p.symbol,
    case when p.mom_ma_golden is null then null::int when p.mom_ma_golden then 1 else 0 end as mom_ma_golden,
    case when p.mom_ret_diff is null then null::int when p.mom_ret_diff then 1 else 0 end as mom_ret_diff,
    case when p.mom_rsi_strong is null then null::int when p.mom_rsi_strong then 1 else 0 end as mom_rsi_strong,
    case when p.mom_breakout is null then null::int when p.mom_breakout then 1 else 0 end as mom_breakout,
    case when p.rev_off_high is null then null::int when p.rev_off_high then 1 else 0 end as rev_off_high,
    case when p.rev_vol_dry is null then null::int when p.rev_vol_dry then 1 else 0 end as rev_vol_dry,
    p.rsi14, p.off_high_60d_pct, p.ret_20d_pct, p.ret_60d_pct, p.ret_5d_pct,
    p.ma20_now, p.ma60_now, p.latest_close, p.latest_date,
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
  -- 7 fund + 4 mom + 2 rev + 5 chip = 18 factor int 0/1/null
  fund.fund_eps_pos, fund.fund_eps_yoy, fund.fund_roe_high,
  fund.fund_fcf_pos, fund.fund_peg_low, fund.fund_rev_yoy, fund.fund_gross_up,
  price.mom_ma_golden, price.mom_ret_diff, price.mom_rsi_strong, price.mom_breakout,
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
  -- 動能 4 條(加 mom_breakout)
  coalesce(case when price.mom_ma_golden = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_ret_diff = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_rsi_strong = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_breakout = 1 then 1 else 0 end, 0) as mom_count_pos,
  (case when price.mom_ma_golden is not null then 1 else 0 end
    + case when price.mom_ret_diff is not null then 1 else 0 end
    + case when price.mom_rsi_strong is not null then 1 else 0 end
    + case when price.mom_breakout is not null then 1 else 0 end) as mom_count_total,
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
  price.ma20_now, price.ma60_now, price.latest_close, price.latest_date,
  price.high_20d, price.vol_latest,
  chip.foreign_net_latest, chip.foreign_net_3d_sum,
  chip.margin_balance_latest, chip.margin_delta_5d_sum,
  chip.lending_latest, chip.lending_prev,
  chip.foreign_ratio_latest, chip.foreign_ratio_prev,
  chip.three_major_net_3d_sum, chip.volume_3d_sum
from universe_symbols u
left join fund on fund.symbol = u.symbol
left join price on price.symbol = u.symbol
left join chip on chip.symbol = u.symbol;

comment on view public.v_factor_scores is
  'M9.2 多因子 18 條 v3:7 fund(ROE 用 settings)+ 4 mom(加 mom_breakout)+ 2 rev + 5 chip。
   PEG / ROE 門檻從 app_settings 拿(peg_threshold 預設 1.2,roe_threshold 預設 10)。';
