-- M9.1: v_factor_scores v2 — 7 fund + 3 mom + 2 rev + 5 chip = 17 factor
--
-- 變動:
--   基本面 6 → 7 條:加 fund_gross_up(三率升 proxy:gross_margin_yoy_pp > 0)
--   動能 3 條不變(只是 mom_rsi_ok 改名 mom_rsi_strong,v_price_factors 已改)
--   反轉 2 條不變
--   籌碼 4 → 5 條:加 chip_inst_concentration(v_chip_factors 已加)
--
-- 額外:fund_peg_low 改從 app_settings 拿 peg_threshold(預設 1.2)。
--   做法:CTE settings select 一次 value,後面 case when 用 cross join 拿。
--   注意:view 是 inline 計算,settings 改變後 view 結果立刻反映(這是想要的,不影響歷史 backtest
--         因為 backtest 走 score_universe_at 那條路徑)。

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
    ) as peg_threshold
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
    -- f3:ROE > 15%
    case
      when ss.roe_ttm is null then null::int
      when ss.roe_ttm > 15 then 1 else 0
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
    -- f7 (NEW):毛利率 YoY 上升(三率升 proxy)
    case
      when ss.gross_margin_yoy_pp is null then null::int
      when ss.gross_margin_yoy_pp > 0 then 1 else 0
    end as fund_gross_up
  from public.v_stock_score ss
  cross join settings s
),
-- 動能 + 反轉:從 v_price_factors 拿 boolean 轉 1/0(mom_rsi_ok → mom_rsi_strong)
price as (
  select
    p.symbol,
    case when p.mom_ma_golden is null then null::int when p.mom_ma_golden then 1 else 0 end as mom_ma_golden,
    case when p.mom_ret_diff is null then null::int when p.mom_ret_diff then 1 else 0 end as mom_ret_diff,
    case when p.mom_rsi_strong is null then null::int when p.mom_rsi_strong then 1 else 0 end as mom_rsi_strong,
    case when p.rev_off_high is null then null::int when p.rev_off_high then 1 else 0 end as rev_off_high,
    case when p.rev_vol_dry is null then null::int when p.rev_vol_dry then 1 else 0 end as rev_vol_dry,
    p.rsi14, p.off_high_60d_pct, p.ret_20d_pct, p.ret_60d_pct, p.ret_5d_pct,
    p.ma20_now, p.ma60_now, p.latest_close, p.latest_date
  from public.v_price_factors p
),
-- 籌碼 5 條(加 chip_inst_concentration)
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
  -- 7 fund + 3 mom + 2 rev + 5 chip = 17 factor int 0/1/null
  fund.fund_eps_pos, fund.fund_eps_yoy, fund.fund_roe_high,
  fund.fund_fcf_pos, fund.fund_peg_low, fund.fund_rev_yoy, fund.fund_gross_up,
  price.mom_ma_golden, price.mom_ret_diff, price.mom_rsi_strong,
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
  coalesce(case when price.mom_ma_golden = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_ret_diff = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_rsi_strong = 1 then 1 else 0 end, 0) as mom_count_pos,
  (case when price.mom_ma_golden is not null then 1 else 0 end
    + case when price.mom_ret_diff is not null then 1 else 0 end
    + case when price.mom_rsi_strong is not null then 1 else 0 end) as mom_count_total,
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
  'M9.1 多因子 17 條 v2:7 fund(加 fund_gross_up)+ 3 mom(mom_rsi_strong)+ 2 rev + 5 chip(加 chip_inst_concentration)。
   PEG 門檻從 app_settings.peg_threshold 拿(預設 1.2,settings 改變即生效)。';
