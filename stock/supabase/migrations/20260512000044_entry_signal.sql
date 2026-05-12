-- M9: v_entry_signal — 多條件對齊的「進場訊號」
--
-- 規則(原 spec):
--   base    fund_count_pos ≥ 4(基本面 6 條至少過 4 條)
--   align   mom_count_pos ≥ 2 AND chip_count_pos ≥ 2
--
-- 籌碼資料未到位時(M8 4 個新表還在 cron 累積),放寬條件:
--   若 chip_count_total = 0 → 規則退化為「fund_count_pos ≥ 4 AND mom_count_pos ≥ 2」
--   若 chip_count_total > 0 但 < 3 → 規則退化為「fund + mom + chip ≥ 1」
--
-- 為什麼這樣設計:嚴格 chip≥2 在資料未累積前永遠不會亮,等於無功能。但又不能完全跳過 chip,
--   否則資料就緒後規則語意改變,backtest 失效。
--   折衷:資料就緒(>= 3 factor)才用 chip≥2 嚴格條件,否則 fallback。

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
  -- ============ Entry signal ============
  case
    -- 硬條件:基本面 ≥ 4(可用 factor 不到 4 也不能放寬)
    when r.fund_count_total is null or r.fund_count_total < 4 then false
    when r.fund_count_pos < 4 then false
    -- 硬條件:動能 ≥ 2(動能 factor 至少 2 個 pass)
    when r.mom_count_total < 2 or r.mom_count_pos < 2 then false
    -- 籌碼條件 — 三層:
    when r.chip_count_total >= 3 then (r.chip_count_pos >= 2)
    when r.chip_count_total > 0 then (r.chip_count_pos >= 1)
    else true  -- chip 資料完全沒到 → 不卡 chip
  end as is_entry_signal,
  -- 訊號強度分級(給 UI 顯示)
  case
    when r.fund_count_total is null or r.fund_count_total < 4 then 'insufficient_data'
    when r.fund_count_pos >= 5
      and r.mom_count_pos >= 2
      and (r.chip_count_total < 3 or r.chip_count_pos >= 2) then 'strong'
    when r.fund_count_pos >= 4
      and r.mom_count_pos >= 2
      and (r.chip_count_total = 0 or r.chip_count_pos >= 1) then 'normal'
    else 'none'
  end as signal_strength
from public.v_stock_rank r;

comment on view public.v_entry_signal is
  'M9 進場訊號:fund≥4(硬條件)+ mom≥2 + chip 三層 fallback(資料缺則放寬)。
   signal_strength:strong(fund≥5 全對齊)/ normal(基本對齊)/ none / insufficient_data。
   若 entry signal 數 > 50 須回 v_factor_scores tune factor threshold。';
