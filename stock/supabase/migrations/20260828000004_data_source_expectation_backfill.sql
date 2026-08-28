-- 補齊 data_source_expectation 的監控盲區(2026-08-28)
--
-- 問題:fetch_log 近 30 天有 35 個 source,data_source_expectation 只有 17 列 → 18 個盲區。
-- 盲區的意義([[L65]]):這些 source 死掉時會**整列從 /health 消失**,而不是變紅 ——
-- 「壞掉」跟「不存在」長得一模一樣。
--
-- 最諷刺的兩個:`etf_metadata_sync` 與 `reselect_industry_stocks` —— **正是 [[L61]] 抓到的那兩支**
-- (FinMind 同一 stock_id 回多筆導致 upsert 整批炸掉,靜默停更數週)。修了 bug,沒補期望列,
-- 下次再死還是看不見。
--
-- 18 個盲區裡只補 14 個。**刻意不補的 4 個**:
--   finmind_institutional / finmind_margin / finmind_lending / finmind_shareholding
-- 這四支是 dedicated EF 的舊 source 名,已於 2026-08-11 前後全數改走 fetch-finmind-backfill
-- (見 20260811000008 / 20260812000002),最後執行分別停在 08-08 ~ 08-11。
-- 它們是**刻意退役**不是壞掉,補進期望清單只會製造永久 danger。
-- (對應的新 source backfill_institutional / backfill_margin / backfill_lending /
--  backfill_shareholding 早已在清單內。)
--
-- max_age_days 依實測跑動頻率設定,寬鬆一格避免假警報:
--   每日 → 3 / 平日每日 → 4 / 每週 → 10 / 每月 → 40

insert into public.data_source_expectation (source, max_age_days, note) values
  ('backfill_valuation',       4,  '平日 10:30 PE/PB'),
  ('backfill_fundamentals',    10, '週日 19:00 季報'),
  ('backfill_monthly_revenue', 10, '週日 20:00 月營收'),
  ('etf_metadata_sync',        10, '週六 20:00 ETF 名單。[[L61]] duplicate key 曾靜默停更數週'),
  ('reselect_industry_stocks', 40, '月初 03:00 產業前 N 檔。[[L61]] 同一個坑;2026-08-01 cron 路徑失敗過'),
  ('events_twse_t187ap04',     3,  '每日 13:30 TWSE 法說會'),
  ('events_twse_t187ap38',     3,  '每日 13:30 TWSE 除權息預告'),
  ('events_twse_twt48u',       3,  '每日 13:30 TWSE 停資停券'),
  ('events_tpex_prepost',      3,  '每日 13:30 TPEX 法說會'),
  ('google_news_intl',         4,  '國際新聞 RSS'),
  ('paper_track',              10, '週六 22:00 紙上交易結算'),
  ('telegram_holdings_advice', 4,  '平日持股建議推播'),
  ('twse_names',               10, '週日 12:30 上市股名'),
  ('tpex_names',               10, '週日 12:30 上櫃股名')
on conflict (source) do nothing;
