-- M9.3: PEG 1.2 → 1.5 + 新增 budget_ntd setting
--
-- 變動原因(2026-05-13,根據 M9.2 baseline 2024 backtest 結果):
--   * 2024 全年:勝率 56.7% / 累積 +17.2% / alpha vs 0050 = -29.45%
--   * 系統錯過 TSMC/聯發科這種「PEG 偏高的續強龍頭」
--     - TSMC 2024 PEG 常在 1.3-1.6 區間;聯發科 PEG 1.4-1.8
--     - PEG 1.2 太嚴格,把續強龍頭擋在進場訊號外
--   * 把 PEG 放寬到 1.5,允許更多大型股入榜
--
-- budget_ntd:預算 filter(NEW)
--   * 0 = 不 filter(顯示全部)
--   * > 0 = 只顯示「1 張成本 ≤ budget_ntd」的標的(現價 × 1000)
--   * 預設 0,Andy 自己在 Settings UI 設

update public.app_settings
   set value = 1.5,
       updated_at = now()
 where key = 'peg_threshold';

insert into public.app_settings (key, value, description) values
  ('budget_ntd', 0, '投資預算(NT$)— 0 = 不 filter,>0 = 只顯示 1 張成本 ≤ 此預算的標的')
on conflict (key) do update
  set description = excluded.description;
