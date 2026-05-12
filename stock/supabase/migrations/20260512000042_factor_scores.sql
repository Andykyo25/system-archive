-- M9: v_factor_scores — 把所有 factor 統一成 0-1 分數
--
-- 維度與 factor:
--   基本面 6 條(從 v_stock_score 衍生):
--     fund_eps_pos     最近 4 季 EPS 皆 > 0
--     fund_eps_yoy     EPS YoY > 0
--     fund_roe_high    ROE > 15%
--     fund_fcf_pos     FCF (TTM) > 0
--     fund_peg_low     PEG < 1
--     fund_rev_yoy     最近月營收 YoY > 0
--   動能 3 條(從 v_price_factors):
--     mom_ma_golden / mom_ret_diff / mom_rsi_ok
--   反轉 2 條(從 v_price_factors):
--     rev_off_high / rev_vol_dry
--   籌碼 4 條(從 v_chip_factors):
--     chip_foreign_3d_buy / chip_margin_drop / chip_lending_drop / chip_share_concentrate
--
-- 每個 factor:1 = 條件成立 / 0 = 不成立 / null = 資料不足無法評估
--
-- 也輸出每維度 fund_count_pos / mom_count_pos / rev_count_pos / chip_count_pos
-- 與該維度的 non-null factor 數(_count_total),供 v_entry_signal 計算「對齊比例」

drop view if exists public.v_factor_scores cascade;

create view public.v_factor_scores as
with universe_symbols as (
  -- 用 v_chip_factors 的範圍(已 union 過所有來源,且包含 stock,但 etf 由 v_price_factors 補)
  select symbol from public.v_price_factors
  union
  select symbol from public.v_chip_factors
),
-- 基本面 6 條:從 v_stock_score 拿原值,decide 條件
fund as (
  select
    ss.symbol,
    -- f1:過去 4 季 EPS 皆 > 0(需資料量達 4)
    case
      when ss.quarters_available is null or ss.quarters_available < 4 then null::int
      when ss.eps_pos_quarters >= 4 then 1
      else 0
    end as fund_eps_pos,
    -- f2:EPS YoY > 0(用 last_q_eps_yoy_pct,有 fallback 用 eps_yoy_pct)
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
    -- f5:PEG < 1(且 > 0,避免 EPS 衰退時 PEG 為負誤計)
    case
      when ss.peg is null then null::int
      when ss.peg > 0 and ss.peg < 1 then 1 else 0
    end as fund_peg_low,
    -- f6:月營收 YoY > 0
    case
      when ss.latest_revenue_yoy_pct is null then null::int
      when ss.latest_revenue_yoy_pct > 0 then 1 else 0
    end as fund_rev_yoy
  from public.v_stock_score ss
),
-- 動能 + 反轉:從 v_price_factors 拿 boolean 轉 1/0
price as (
  select
    p.symbol,
    case when p.mom_ma_golden is null then null::int when p.mom_ma_golden then 1 else 0 end as mom_ma_golden,
    case when p.mom_ret_diff is null then null::int when p.mom_ret_diff then 1 else 0 end as mom_ret_diff,
    case when p.mom_rsi_ok is null then null::int when p.mom_rsi_ok then 1 else 0 end as mom_rsi_ok,
    case when p.rev_off_high is null then null::int when p.rev_off_high then 1 else 0 end as rev_off_high,
    case when p.rev_vol_dry is null then null::int when p.rev_vol_dry then 1 else 0 end as rev_vol_dry,
    p.rsi14, p.off_high_60d_pct, p.ret_20d_pct, p.ret_60d_pct, p.ret_5d_pct,
    p.ma20_now, p.ma60_now, p.latest_close, p.latest_date
  from public.v_price_factors p
),
chip as (
  select
    c.symbol,
    case when c.chip_foreign_3d_buy is null then null::int when c.chip_foreign_3d_buy then 1 else 0 end as chip_foreign_3d_buy,
    case when c.chip_margin_drop is null then null::int when c.chip_margin_drop then 1 else 0 end as chip_margin_drop,
    case when c.chip_lending_drop is null then null::int when c.chip_lending_drop then 1 else 0 end as chip_lending_drop,
    case when c.chip_share_concentrate is null then null::int when c.chip_share_concentrate then 1 else 0 end as chip_share_concentrate,
    c.foreign_net_latest, c.foreign_net_3d_sum,
    c.margin_balance_latest, c.margin_delta_5d_sum,
    c.lending_latest, c.lending_prev,
    c.foreign_ratio_latest, c.foreign_ratio_prev
  from public.v_chip_factors c
)
select
  u.symbol,
  -- factor 值(int 0/1/null)
  fund.fund_eps_pos, fund.fund_eps_yoy, fund.fund_roe_high,
  fund.fund_fcf_pos, fund.fund_peg_low, fund.fund_rev_yoy,
  price.mom_ma_golden, price.mom_ret_diff, price.mom_rsi_ok,
  price.rev_off_high, price.rev_vol_dry,
  chip.chip_foreign_3d_buy, chip.chip_margin_drop,
  chip.chip_lending_drop, chip.chip_share_concentrate,
  -- 各維度通過數 / 可評數(null 不計入分母,也不計入分子)
  coalesce(case when fund.fund_eps_pos = 1 then 1 else 0 end, 0)
    + coalesce(case when fund.fund_eps_yoy = 1 then 1 else 0 end, 0)
    + coalesce(case when fund.fund_roe_high = 1 then 1 else 0 end, 0)
    + coalesce(case when fund.fund_fcf_pos = 1 then 1 else 0 end, 0)
    + coalesce(case when fund.fund_peg_low = 1 then 1 else 0 end, 0)
    + coalesce(case when fund.fund_rev_yoy = 1 then 1 else 0 end, 0) as fund_count_pos,
  (case when fund.fund_eps_pos is not null then 1 else 0 end
    + case when fund.fund_eps_yoy is not null then 1 else 0 end
    + case when fund.fund_roe_high is not null then 1 else 0 end
    + case when fund.fund_fcf_pos is not null then 1 else 0 end
    + case when fund.fund_peg_low is not null then 1 else 0 end
    + case when fund.fund_rev_yoy is not null then 1 else 0 end) as fund_count_total,
  coalesce(case when price.mom_ma_golden = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_ret_diff = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_rsi_ok = 1 then 1 else 0 end, 0) as mom_count_pos,
  (case when price.mom_ma_golden is not null then 1 else 0 end
    + case when price.mom_ret_diff is not null then 1 else 0 end
    + case when price.mom_rsi_ok is not null then 1 else 0 end) as mom_count_total,
  coalesce(case when price.rev_off_high = 1 then 1 else 0 end, 0)
    + coalesce(case when price.rev_vol_dry = 1 then 1 else 0 end, 0) as rev_count_pos,
  (case when price.rev_off_high is not null then 1 else 0 end
    + case when price.rev_vol_dry is not null then 1 else 0 end) as rev_count_total,
  coalesce(case when chip.chip_foreign_3d_buy = 1 then 1 else 0 end, 0)
    + coalesce(case when chip.chip_margin_drop = 1 then 1 else 0 end, 0)
    + coalesce(case when chip.chip_lending_drop = 1 then 1 else 0 end, 0)
    + coalesce(case when chip.chip_share_concentrate = 1 then 1 else 0 end, 0) as chip_count_pos,
  (case when chip.chip_foreign_3d_buy is not null then 1 else 0 end
    + case when chip.chip_margin_drop is not null then 1 else 0 end
    + case when chip.chip_lending_drop is not null then 1 else 0 end
    + case when chip.chip_share_concentrate is not null then 1 else 0 end) as chip_count_total,
  -- 輔助欄位(雷達圖 + UI hover 用)
  price.rsi14, price.off_high_60d_pct, price.ret_20d_pct, price.ret_60d_pct, price.ret_5d_pct,
  price.ma20_now, price.ma60_now, price.latest_close, price.latest_date,
  chip.foreign_net_latest, chip.foreign_net_3d_sum,
  chip.margin_balance_latest, chip.margin_delta_5d_sum,
  chip.lending_latest, chip.lending_prev,
  chip.foreign_ratio_latest, chip.foreign_ratio_prev
from universe_symbols u
left join fund on fund.symbol = u.symbol
left join price on price.symbol = u.symbol
left join chip on chip.symbol = u.symbol;

comment on view public.v_factor_scores is
  'M9 多因子整合 view:每 symbol 11 factor + 4 維度通過數/可評數 + 輔助欄位。
   每 factor:1=true / 0=false / null=資料不足。各維度 _count_pos / _count_total 給 v_entry_signal 算對齊比例。';
