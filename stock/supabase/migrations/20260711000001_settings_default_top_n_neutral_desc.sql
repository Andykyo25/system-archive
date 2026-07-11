-- 20260711000001: default_top_n description 中性化(DB 資料面收尾)
--
-- 背景:L48(tasks/lessons.md)證實 M9.4a「top5 集中度 2025 OOS alpha +24.19」
--   是 C1 PIT 前視偏誤假象(score_universe_at 拿會計期間當可得日,選股偷看未公告財報)。
--   修正後 top5 2024 −50.65 / 2025 −9.02,輸 0050 — 該宣稱不成立。
-- UI 端已更正:2026-06-30 A4(/rank 頁改「純顯示偏好、非績效宣稱」)+ 2026-07-10(/settings 頁)。
--   但 production DB app_settings.description 仍留 20260519000006 種入的舊文字(含 +24.19 宣稱)。
--   UI 目前不渲染此欄(DefaultTopNRow 用硬編碼描述、default_top_n 被排除在通用 SettingRow 之外),
--   屬 latent 髒資料 — 若未來任何 UI/報表直接渲染 setting.description,會把已否證的績效宣稱端給使用者。
-- 此 migration = DB 資料面收尾:description 換成中性文字(比照 A4 措辭,績效以 /backtest 為準)。
-- 舊 migration 20260519000006 不改動(immutable 歷史)。
-- 只動 description、不動 value — 保護 Andy 已切的檔數偏好(與 20260519000006 的刻意設計一致)。

update public.app_settings
set description = '/rank 預設精選檔數(整數 5~50;純顯示偏好、非績效宣稱,績效以 /backtest 為準)。?focus= 可臨時覆寫'
where key = 'default_top_n';
