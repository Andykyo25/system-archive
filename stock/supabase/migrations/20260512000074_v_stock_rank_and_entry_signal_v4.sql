-- M9.3: v_stock_rank + v_entry_signal v4 + v_rank_with_cost (NEW)
--
-- v_stock_rank 變動:
--   * factor pass-through 加 mom_above_ma200(18 → 19 軸對應)
--   * weights 仍從 app_settings 拿(預設 40/30/10/20),算法不變
--   * 動能 count_pos / count_total 因 v_factor_scores 已改算 5 條,view 直接 select 即可
--
-- v_entry_signal 變動:
--   * 硬條件 A(rev_yoy=1)、B(fund≥3)、C(mom≥2)不變
--   * 籌碼三層 fallback 不變
--   * strength.strong 改:
--     舊(M9.2):mom≥3(3/4 = 75%)
--     新(M9.3):mom≥4(4/5 = 80% — 動能總數 5 對應)
--   * normal 規則 mom≥2(2/5 = 40%),比 M9.2 mom≥2/4 = 50% 略寬,預期(更敏銳)
--
-- 為什麼 strong mom≥4:
--   M9.2 mom≥3 in 4 條 = 75%。M9.3 動能加到 5 條,要維持類似嚴格度,
--   應該 mom≥4 in 5 = 80%(略嚴一點)。
--   3/5 = 60% 太寬,2/5 已是 normal 規則。
--   spec L33 文字「mom_count_pos >= 4」明確要求 4/5。
--
-- ============= v_rank_with_cost (NEW M9.3) =============
-- 把 v_stock_rank join v_latest_price_realtime,加 cost_per_lot_ntd 欄位
--   cost_per_lot_ntd = current_price × 1000(1 張 = 1000 股)
-- 用途:/rank 頁讀此 view filter「1 張成本 ≤ budget_ntd」
-- 為什麼不寫進 v_stock_rank:
--   v_stock_rank 是純 factor 邏輯,join realtime price 會讓「歷史 backtest」用的
--   score_universe_at 也帶到 realtime 概念(語意混亂)。
--   獨立一個 view 給 UI filter 用更乾淨。

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
  -- 各 factor pass-through(雷達圖 19 軸 = 7+5+2+5)
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
  s.three_major_net_3d_sum, s.volume_3d_sum
from scored s;

comment on view public.v_stock_rank is
  'M9.3 加權總分 v4:19 factor pass-through(7+5+2+5)。weights 從 app_settings(預設 40/30/10/20)。
   expected_rank asc 1 = 最強。';

-- ====================================================================
-- v_entry_signal v4(strength.strong 對應 5 條動能,mom≥4)
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
  -- ============ Entry signal(M9.1 規則,M9.3 動能總數 5 不影響硬條件 mom≥2)============
  case
    -- 資料不足:fund 可評不到 4 → 無法判斷
    when r.fund_count_total is null or r.fund_count_total < 4 then false
    -- 硬條件 A:月營收 YoY 必須過(rev_yoy = 1)
    when r.fund_rev_yoy is null or r.fund_rev_yoy <> 1 then false
    -- 硬條件 B:基本面 ≥ 3 條過
    when r.fund_count_pos < 3 then false
    -- 硬條件 C:動能 ≥ 2 條過(5 條制下 40%,但仍是基本門檻)
    when r.mom_count_total < 2 or r.mom_count_pos < 2 then false
    -- 籌碼三層 fallback(總條數 5 對應)
    when r.chip_count_total >= 4 then (r.chip_count_pos >= 3)
    when r.chip_count_total > 0 then (r.chip_count_pos >= 1)
    else true
  end as is_entry_signal,
  -- 訊號強度(M9.3 strong mom≥4 對應 5 條制 = 80% 達標)
  case
    when r.fund_count_total is null or r.fund_count_total < 4 then 'insufficient_data'
    when r.fund_rev_yoy is null or r.fund_rev_yoy <> 1 then 'none'
    when r.fund_count_pos >= 5
      and r.mom_count_pos >= 4
      and (r.chip_count_total < 4 or r.chip_count_pos >= 3) then 'strong'
    when r.fund_count_pos >= 3
      and r.mom_count_pos >= 2
      and (r.chip_count_total = 0 or r.chip_count_pos >= 1) then 'normal'
    else 'none'
  end as signal_strength
from public.v_stock_rank r;

comment on view public.v_entry_signal is
  'M9.3 進場訊號 v4:月營收 YoY 必過 + fund≥3 + mom≥2 + chip 三層 fallback。
   strength: strong(fund≥5 + mom≥4 in 5 + chip 嚴格)/ normal / insufficient_data / none。';

-- ====================================================================
-- v_rank_with_cost (NEW M9.3) — rank + 1 張成本(給 /rank 預算 filter 用)
-- ====================================================================

drop view if exists public.v_rank_with_cost cascade;

create view public.v_rank_with_cost as
select
  r.*,
  lp.current_price,
  lp.as_of_ts,
  lp.source as price_source,
  lp.is_provisional as price_is_provisional,
  case
    when lp.current_price is null then null::numeric
    else lp.current_price * 1000  -- 台股 1 張 = 1000 股
  end as cost_per_lot_ntd
from public.v_stock_rank r
left join public.v_latest_price_realtime lp on lp.symbol = r.symbol;

comment on view public.v_rank_with_cost is
  'M9.3:v_stock_rank join v_latest_price_realtime,加 cost_per_lot_ntd(1 張成本 NT$)。
   /rank 頁讀此 view 配合 app_settings.budget_ntd 做預算 filter。';
