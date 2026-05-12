-- M9: v_stock_rank — 多因子加權總分 + 排名
--
-- 權重設計(總和 100%):
--   基本面 50%(6 factor)
--   動能   25%(3 factor)
--   反轉   15%(2 factor)
--   籌碼   10%(4 factor)
--
-- 各維度貢獻 = (count_pos / count_total) × weight,若 count_total=0(資料完全沒到)
--   則該維度權重「重新分配」給其他有資料的維度,避免籌碼空時所有人都被打折
--
-- 輸出 weighted_score(0-100)+ rank(asc 1 = 最強)

drop view if exists public.v_stock_rank cascade;

create view public.v_stock_rank as
with weights as (
  select
    0.50::numeric as w_fund,
    0.25::numeric as w_mom,
    0.15::numeric as w_rev,
    0.10::numeric as w_chip
),
-- 每維度的「可用權重」(有資料才算)
weighted as (
  select
    fs.*,
    -- 該維度有 factor 可評就保留權重,否則歸 0
    case when fs.fund_count_total > 0 then w.w_fund else 0 end as eff_w_fund,
    case when fs.mom_count_total  > 0 then w.w_mom  else 0 end as eff_w_mom,
    case when fs.rev_count_total  > 0 then w.w_rev  else 0 end as eff_w_rev,
    case when fs.chip_count_total > 0 then w.w_chip else 0 end as eff_w_chip
  from public.v_factor_scores fs
  cross join weights w
),
normalized as (
  select
    *,
    (eff_w_fund + eff_w_mom + eff_w_rev + eff_w_chip) as total_eff_w
  from weighted
),
scored as (
  select
    *,
    case
      when total_eff_w = 0 then null::numeric(8,4)
      else (
        -- 各維度貢獻:(pos/total) × eff_w / total_eff_w × 100
        (case when fund_count_total > 0 then fund_count_pos::numeric / fund_count_total else 0 end) * eff_w_fund
        + (case when mom_count_total > 0 then mom_count_pos::numeric / mom_count_total else 0 end) * eff_w_mom
        + (case when rev_count_total > 0 then rev_count_pos::numeric / rev_count_total else 0 end) * eff_w_rev
        + (case when chip_count_total > 0 then chip_count_pos::numeric / chip_count_total else 0 end) * eff_w_chip
      ) / total_eff_w * 100
    end as weighted_score
  from normalized
)
select
  s.symbol,
  s.weighted_score,
  -- expected_rank(asc 1 = 最高分),null score 排到最後
  row_number() over (order by s.weighted_score desc nulls last, s.symbol asc) as expected_rank,
  -- 各維度分數(0-100)供 UI 顯示
  case when s.fund_count_total > 0
    then (s.fund_count_pos::numeric / s.fund_count_total) * 100 end as fund_score_pct,
  case when s.mom_count_total > 0
    then (s.mom_count_pos::numeric / s.mom_count_total) * 100 end as mom_score_pct,
  case when s.rev_count_total > 0
    then (s.rev_count_pos::numeric / s.rev_count_total) * 100 end as rev_score_pct,
  case when s.chip_count_total > 0
    then (s.chip_count_pos::numeric / s.chip_count_total) * 100 end as chip_score_pct,
  s.fund_count_pos, s.fund_count_total,
  s.mom_count_pos, s.mom_count_total,
  s.rev_count_pos, s.rev_count_total,
  s.chip_count_pos, s.chip_count_total,
  -- 各 factor pass-through(雷達圖用)
  s.fund_eps_pos, s.fund_eps_yoy, s.fund_roe_high,
  s.fund_fcf_pos, s.fund_peg_low, s.fund_rev_yoy,
  s.mom_ma_golden, s.mom_ret_diff, s.mom_rsi_ok,
  s.rev_off_high, s.rev_vol_dry,
  s.chip_foreign_3d_buy, s.chip_margin_drop,
  s.chip_lending_drop, s.chip_share_concentrate,
  -- 輔助欄
  s.rsi14, s.off_high_60d_pct, s.ret_20d_pct, s.ret_60d_pct, s.ret_5d_pct,
  s.ma20_now, s.ma60_now, s.latest_close, s.latest_date,
  s.foreign_net_latest, s.margin_balance_latest, s.lending_latest, s.foreign_ratio_latest
from scored s;

comment on view public.v_stock_rank is
  'M9 加權總分 + 排名:基本面 50% / 動能 25% / 反轉 15% / 籌碼 10%(資料缺維度權重 reallocate)。
   expected_rank asc 1 = 最強,輸出全維度分數 + 各 factor pass-through 給 UI 雷達圖。';
