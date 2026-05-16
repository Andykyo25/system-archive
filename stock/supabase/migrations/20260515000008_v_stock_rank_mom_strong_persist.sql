-- M9.4c 階段 3 Step 1:v_stock_rank pass-through 加 mom_strong_persist(2026-05-16)
--
-- weighted_score 算法不變(weights 從 app_settings)。動能 count 由
-- v_factor_scores 已改算 6 條,v_stock_rank select fs.* 即自動反映
-- (eff_w_mom 加權分母用 mom_count_total=6)。
--
-- ⚠ append-only CREATE OR REPLACE:mom_strong_persist 加在 select 最尾端,
--   既有欄位名稱/型別/順序全不動 → 完全避開 cascade。
--   **不動 v_entry_signal / v_rank_with_cost / v_holdings_advice**:
--   Andy 拍板 strong 維持 mom≥4 絕對值(4/6=67%),entry 邏輯不改;
--   v_rank_with_cost 用 r.*(建立時固定欄位,新欄不影響);
--   v_holdings_advice 讀既有欄,皆不破。
--
-- L32:score_universe_at 同步加 mom_strong_persist(20260515000009)。

create or replace view public.v_stock_rank as
with weights as (
  select
    coalesce((select value from public.app_settings where key = 'weight_fund'), 0.40::numeric) as w_fund,
    coalesce((select value from public.app_settings where key = 'weight_mom'),  0.30::numeric) as w_mom,
    coalesce((select value from public.app_settings where key = 'weight_rev'),  0.10::numeric) as w_rev,
    coalesce((select value from public.app_settings where key = 'weight_chip'), 0.20::numeric) as w_chip
),
weighted as (
  select
    fs.*,
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
  row_number() over (order by s.weighted_score desc nulls last, s.symbol asc) as expected_rank,
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
  -- 各 factor pass-through(原 19 軸,名稱/順序不動 = append-only)
  s.fund_eps_pos, s.fund_eps_yoy, s.fund_roe_high,
  s.fund_fcf_pos, s.fund_peg_low, s.fund_rev_yoy, s.fund_gross_up,
  s.mom_ma_golden, s.mom_ret_diff, s.mom_rsi_strong,
  s.mom_breakout, s.mom_above_ma200,
  s.rev_off_high, s.rev_vol_dry,
  s.chip_foreign_3d_buy, s.chip_margin_drop,
  s.chip_lending_drop, s.chip_share_concentrate, s.chip_inst_concentration,
  -- 輔助欄
  s.rsi14, s.off_high_60d_pct, s.ret_20d_pct, s.ret_60d_pct, s.ret_5d_pct,
  s.ma20_now, s.ma60_now, s.ma200_now, s.latest_close, s.latest_date,
  s.high_20d, s.vol_latest,
  s.foreign_net_latest, s.margin_balance_latest, s.lending_latest, s.foreign_ratio_latest,
  s.three_major_net_3d_sum, s.volume_3d_sum,
  -- M9.4c:append-only 尾欄(雷達圖第 20 軸)
  s.mom_strong_persist
from scored s;

comment on view public.v_stock_rank is
  'M9.4c 加權總分:20 factor pass-through(7+6+2+5)。weights 從 app_settings
   (預設 40/30/10/20)。expected_rank asc 1 = 最強。mom_count_total=6。';
