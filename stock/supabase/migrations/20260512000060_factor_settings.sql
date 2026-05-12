-- M9.1: factor 模型短中線設定(放進 app_settings 才能不動 view 微調權重)
--
-- 變動原因(2026-05-12,台股分析師建議):
--   * PEG 1.0 太嚴格 → 1.2(放寬 — 台股估值普遍比美股高一點)
--   * 短中線權重重分配:
--     - 基本面 50% → 40%(short 一點,放給其他維度)
--     - 動能   25% → 30%(短中線動能比基本面更貼價)
--     - 反轉   15% → 10%(反轉是加分項,降權)
--     - 籌碼   10% → 20%(台股是籌碼市場,法人動向比想像中重要)
--   * total 仍 = 100,view 計算「資料缺維度則 reallocate 比例」邏輯不變
--
-- 為什麼用 app_settings 不 hardcode:
--   未來 backtest 證明哪組比較準,改 row 即可,view 不需 rebuild。
--   但同時 score_universe_at 用 stable function 拿,settings 改不會影響「同一天回測」
--   結果(因為 walk-forward 每輪都當下讀 settings,如果改了會 retroactive)— 取捨:
--     若想嚴格 retroactive-immune,要把 weights 寫進 backtest_runs.params jsonb。
--     v1 先簡化:weights 改變後 backtest 結果跟著改,Andy 自己留參數記錄。

insert into public.app_settings (key, value, description) values
  ('peg_threshold', 1.2, '基本面 PEG 因子門檻(PEG < threshold 才算過關)'),
  ('weight_fund', 0.40, '多因子權重 — 基本面維度(短中線預設)'),
  ('weight_mom',  0.30, '多因子權重 — 動能維度'),
  ('weight_rev',  0.10, '多因子權重 — 反轉維度'),
  ('weight_chip', 0.20, '多因子權重 — 籌碼維度(台股籌碼市場特性)')
on conflict (key) do update
  set value = excluded.value,
      description = excluded.description;

comment on table public.app_settings is
  'app 級設定。手續費 / 證交稅(M8.5)+ factor PEG/權重(M9.1)。';
