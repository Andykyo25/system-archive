-- M9.1: v_stock_rank + v_entry_signal v2
--
-- v_stock_rank 變動:
--   weights 從 app_settings 拿(weight_fund / weight_mom / weight_rev / weight_chip),預設 40/30/10/20
--   算法不變:資料缺維度則 reallocate(eff_w = 0 / total_eff_w normalize 後乘 100)
--   factor pass-through 新增 fund_gross_up + chip_inst_concentration + 把 mom_rsi_ok 改為 mom_rsi_strong
--
-- v_entry_signal 變動(重大邏輯):
--   舊規則:fund≥4 + mom≥2 + chip 三層 fallback(≥3 嚴格 ≥2 / >0 ≥1 / =0 不卡)
--   新規則:
--     硬條件 A:fund_rev_yoy = 1(月營收 YoY 必須過 — 分析師建議)
--     硬條件 B:fund_count_pos >= 3(從 ≥4 放寬到 ≥3,避免漏掉轉機股)
--     硬條件 C:mom_count_total >= 2 AND mom_count_pos >= 2
--     籌碼三層 fallback(chip 總條數 5 對應新門檻):
--       chip_count_total >= 4 → chip_count_pos >= 3(從 ≥3/≥2 變 ≥4/≥3)
--       chip_count_total > 0  → chip_count_pos >= 1
--       chip_count_total = 0  → true(不卡 chip)
--   signal_strength:
--     strong:fund_count_pos >= 5 + mom_count_pos >= 3(全 3 條過)+ (chip<4 或 chip≥3)
--     normal:fund_count_pos >= 3 AND fund_rev_yoy = 1 + mom_count_pos >= 2 + (chip=0 或 chip≥1)
--     insufficient_data:fund_count_total < 4
--     none:其他
--
-- 為什麼這樣設計:
--   * 月營收 YoY 是台股研究員「最近期 momentum 確認」的關鍵指標,優先級 > 其他基本面條件
--   * fund≥3(原 4)避免漏掉「轉機股」(EPS 還沒大幅好轉,但營收已開始 turnaround)
--   * 籌碼門檻配 5 條後重新校正:嚴格 ≥3/5(60%) ≈ 舊 ≥2/4(50%),略嚴

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
  -- 各 factor pass-through(雷達圖 17 軸)
  s.fund_eps_pos, s.fund_eps_yoy, s.fund_roe_high,
  s.fund_fcf_pos, s.fund_peg_low, s.fund_rev_yoy, s.fund_gross_up,
  s.mom_ma_golden, s.mom_ret_diff, s.mom_rsi_strong,
  s.rev_off_high, s.rev_vol_dry,
  s.chip_foreign_3d_buy, s.chip_margin_drop,
  s.chip_lending_drop, s.chip_share_concentrate, s.chip_inst_concentration,
  -- 輔助欄
  s.rsi14, s.off_high_60d_pct, s.ret_20d_pct, s.ret_60d_pct, s.ret_5d_pct,
  s.ma20_now, s.ma60_now, s.latest_close, s.latest_date,
  s.foreign_net_latest, s.margin_balance_latest, s.lending_latest, s.foreign_ratio_latest,
  s.three_major_net_3d_sum, s.volume_3d_sum
from scored s;

comment on view public.v_stock_rank is
  'M9.1 加權總分 v2:weights 從 app_settings(預設 fund 40 / mom 30 / rev 10 / chip 20)。
   17 factor pass-through(7+3+2+5)。expected_rank asc 1 = 最強。';

-- ====================================================================
-- v_entry_signal v2
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
  -- ============ Entry signal(新規則)============
  case
    -- 資料不足:fund 可評不到 4 → 無法判斷
    when r.fund_count_total is null or r.fund_count_total < 4 then false
    -- 硬條件 A:月營收 YoY 必須過(rev_yoy = 1)
    when r.fund_rev_yoy is null or r.fund_rev_yoy <> 1 then false
    -- 硬條件 B:基本面 ≥ 3 條過
    when r.fund_count_pos < 3 then false
    -- 硬條件 C:動能 ≥ 2 條過
    when r.mom_count_total < 2 or r.mom_count_pos < 2 then false
    -- 籌碼三層 fallback(總條數 5 對應)
    when r.chip_count_total >= 4 then (r.chip_count_pos >= 3)
    when r.chip_count_total > 0 then (r.chip_count_pos >= 1)
    else true
  end as is_entry_signal,
  -- 訊號強度(更嚴的「強」 / 一般「標準」)
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
  'M9.1 進場訊號 v2(分析師建議):月營收 YoY 必過 + fund≥3 + mom≥2 + chip 三層 fallback。
   strength: strong(fund≥5 全 mom 3 條過 chip 嚴格)/ normal(基本對齊)/ insufficient_data / none。';
