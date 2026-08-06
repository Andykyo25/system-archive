-- M9.4c 階段 3 Step 1:v_factor_scores 動能 5 → 6(加 mom_strong_persist),20 factor
--
-- 變動:
--   * 動能 5 → 6:加 mom_strong_persist(v_price_factors 20260515000006 已加)
--   * mom_count_pos / mom_count_total 動能 5 → 6 對應(既有欄,只改表達式)
--   * mom_strong_persist int 0/1/null pass-through,append 在 select 最尾端
--
-- ⚠ 用 CREATE OR REPLACE(非 drop cascade):新欄只 append 尾端、既有欄
--   名稱/型別/順序全不動、mom_count 僅改表達式 → Postgres 允許,
--   完全避開 cascade(v_stock_rank/v_entry_signal/v_rank_with_cost/
--   v_holdings_advice/Telegram/rank 全程不破)。
--
-- 基本面 7(不變)/動能 6(加 mom_strong_persist)/反轉 2/籌碼 5 = 20 factor。
-- L32:score_universe_at 同步(20260515000009)。v_entry_signal 不動
--   (Andy 拍板 strong mom≥4 維持絕對值,4/6=67%)。

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
  -- 動能 6 條(M9.4c 加 mom_strong_persist)
  coalesce(case when price.mom_ma_golden = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_ret_diff = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_rsi_strong = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_breakout = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_above_ma200 = 1 then 1 else 0 end, 0)
    + coalesce(case when price.mom_strong_persist = 1 then 1 else 0 end, 0) as mom_count_pos,
  (case when price.mom_ma_golden is not null then 1 else 0 end
    + case when price.mom_ret_diff is not null then 1 else 0 end
    + case when price.mom_rsi_strong is not null then 1 else 0 end
    + case when price.mom_breakout is not null then 1 else 0 end
    + case when price.mom_above_ma200 is not null then 1 else 0 end
    + case when price.mom_strong_persist is not null then 1 else 0 end) as mom_count_total,
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
  'M9.4c 多因子 20 條:7 fund + 6 mom(加 mom_strong_persist)+ 2 rev + 5 chip。
   PEG / ROE 從 app_settings 拿(peg_threshold 預設 1.5,roe_threshold 預設 10)。';
