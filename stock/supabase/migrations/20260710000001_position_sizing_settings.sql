-- 部位管理設定(2026-07-10 拍板規畫②:ATR sizing + 集中度警示)
-- 兩個 knob 進 app_settings(settings 頁 otherSettings 通用列表自動可編輯):
--   risk_pct_per_trade:每筆交易風險預算占資本比(0.01 = 1%)
--   atr_stop_multiple:停損距離 = N × ATR14(Chandelier 慣例 2~3)
-- 只做買入前 sizing 建議與集中度呈現,不動因子/排名/回測(免 OOS 閘)。
-- rollback:delete from public.app_settings where key in ('risk_pct_per_trade','atr_stop_multiple');

insert into public.app_settings (key, value, description) values
  ('risk_pct_per_trade', 0.01, '每筆交易風險預算占資本比(ATR sizing,0.01 = 1%)'),
  ('atr_stop_multiple', 2, '停損距離 = N x ATR14(部位建議張數用)')
on conflict (key) do nothing;
