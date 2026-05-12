-- M9.2: v_stock_rank + v_entry_signal v3
--
-- v_stock_rank 變動:
--   * factor pass-through 加 mom_breakout(17 → 18 軸對應)
--   * weights 仍從 app_settings 拿(預設 40/30/10/20),算法不變
--   * 動能 count_pos / count_total 因 v_factor_scores 已改算 4 條,view 直接 select 即可
--
-- v_entry_signal 變動:
--   * 硬條件 A(rev_yoy=1)、B(fund≥3)、C(mom≥2)不變
--   * 籌碼三層 fallback 不變(≥4 → ≥3 / >0 → ≥1 / =0 → 不卡)
--   * strength 規則 strong 改:
--     舊(M9.1):fund≥5 + mom≥3(3/3 全過,100%)+ chip<4 或 chip≥3
--     新(M9.2):fund≥5 + mom≥3(3/4,75% — 因動能加到 4 條)+ chip<4 或 chip≥3
--   * normal 規則 mom≥2(2/4 = 50%),比 M9.1 mom≥2/3 = 67% 略寬,是預期的(更敏銳)
--
-- 為什麼 strong mom≥3:
--   mom_breakout 是稀有事件(漲停飆股才會過),要求 4/4 全過會吃零 strong signal。
--   3/4 = 75% 在 backtest 容易驗證 + 比 M9.1 3/3 嚴格度差不多(都是「動能大部分過」)。

drop view if exists public.v_stock_rank cascade;

create view public.v_stock_rank as
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
  -- 各 factor pass-through(雷達圖 18 軸 = 7+4+2+5)
  s.fund_eps_pos, s.fund_eps_yoy, s.fund_roe_high,
  s.fund_fcf_pos, s.fund_peg_low, s.fund_rev_yoy, s.fund_gross_up,
  s.mom_ma_golden, s.mom_ret_diff, s.mom_rsi_strong, s.mom_breakout,
  s.rev_off_high, s.rev_vol_dry,
  s.chip_foreign_3d_buy, s.chip_margin_drop,
  s.chip_lending_drop, s.chip_share_concentrate, s.chip_inst_concentration,
  -- 輔助欄
  s.rsi14, s.off_high_60d_pct, s.ret_20d_pct, s.ret_60d_pct, s.ret_5d_pct,
  s.ma20_now, s.ma60_now, s.latest_close, s.latest_date,
  s.high_20d, s.vol_latest,
  s.foreign_net_latest, s.margin_balance_latest, s.lending_latest, s.foreign_ratio_latest,
  s.three_major_net_3d_sum, s.volume_3d_sum
from scored s;

comment on view public.v_stock_rank is
  'M9.2 加權總分 v3:18 factor pass-through(7+4+2+5)。weights 從 app_settings(預設 40/30/10/20)。
   expected_rank asc 1 = 最強。';

-- ====================================================================
-- v_entry_signal v3(strength.strong 對應 4 條動能,mom≥3)
-- ====================================================================

drop view if exists public.v_entry_signal cascade;

create view public.v_entry_signal as
select
  r.symbol,
  r.weighted_score,
  r.expected_rank,
  r.fund_count_pos, r.fund_count_total,
  r.mom_count_pos, r.mom_count_total,
  r.rev_count_pos, r.rev_count_total,
  r.chip_count_pos, r.chip_count_total,
  -- ============ Entry signal(M9.1 規則,M9.2 因動能總數 4 變寬到 50%)============
  case
    -- 資料不足:fund 可評不到 4 → 無法判斷
    when r.fund_count_total is null or r.fund_count_total < 4 then false
    -- 硬條件 A:月營收 YoY 必須過(rev_yoy = 1)
    when r.fund_rev_yoy is null or r.fund_rev_yoy <> 1 then false
    -- 硬條件 B:基本面 ≥ 3 條過
    when r.fund_count_pos < 3 then false
    -- 硬條件 C:動能 ≥ 2 條過(在 4 條制下相當於 50%,M9.1 是 2/3=67%)
    when r.mom_count_total < 2 or r.mom_count_pos < 2 then false
    -- 籌碼三層 fallback(總條數 5 對應)
    when r.chip_count_total >= 4 then (r.chip_count_pos >= 3)
    when r.chip_count_total > 0 then (r.chip_count_pos >= 1)
    else true
  end as is_entry_signal,
  -- 訊號強度(M9.2 strong mom≥3 對應 4 條制 = 75% 達標)
  case
    when r.fund_count_total is null or r.fund_count_total < 4 then 'insufficient_data'
    when r.fund_rev_yoy is null or r.fund_rev_yoy <> 1 then 'none'
    when r.fund_count_pos >= 5
      and r.mom_count_pos >= 3
      and (r.chip_count_total < 4 or r.chip_count_pos >= 3) then 'strong'
    when r.fund_count_pos >= 3
      and r.mom_count_pos >= 2
      and (r.chip_count_total = 0 or r.chip_count_pos >= 1) then 'normal'
    else 'none'
  end as signal_strength
from public.v_stock_rank r;

comment on view public.v_entry_signal is
  'M9.2 進場訊號 v3:月營收 YoY 必過 + fund≥3 + mom≥2 + chip 三層 fallback。
   strength: strong(fund≥5 + mom≥3 in 4 + chip 嚴格)/ normal / insufficient_data / none。';
