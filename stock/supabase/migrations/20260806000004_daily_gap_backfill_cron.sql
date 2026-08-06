-- 每日自動補洞:backfill-market-history 補最近 5 天(2026-08-06)
--
-- 問題根源:`tpex` 收料近 3 天 6 次只成功 3 次(JSON 截斷 / connection body 錯誤),
-- 8/04 上櫃只進 25 檔。而**缺一天的殺傷力被放大**:838 檔上櫃股從 20 bars 掉到 19,
-- 全部算不出 MA20 → v_breakout_scan 的型態條件對上櫃整個失效。
--
-- 為什麼不在 fetch-daily-prices 加重試:重試只降低單次失敗率,連續失敗照樣留洞,
-- 而且失敗後沒有任何機制回頭補。改用「每天無條件補最近 5 天」的收斂式設計 ——
-- 任何單日失敗最多存活到隔天,不需要偵測失敗、不需要判斷該不該補。
-- backfill EF 的寫入是 ignoreDuplicates,重跑對既有資料零影響(冪等)。
--
-- 排程順序(UTC):
--   06:30 fetch-daily-prices  收前一交易日(twse 隔日補、tpex 當日)
--   06:45 本 cron             補最近 5 天的任何洞  ← 此處
--   07:00 freeze-scan-picks   凍結前向樣本(需要完整資料才凍得對)
-- 週一到週六跑(週六補週五;週日無新資料)。
--
-- 成本:每次 5 天 × 2 市場 = 10 個 call,打的是 TWSE/TPEx 公開端點,不吃 FinMind quota。

select cron.schedule(
  'backfill-market-history-daily',
  '45 6 * * 1-6',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/backfill-market-history',
       headers := jsonb_build_object(
         'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
         'Content-Type','application/json'),
       body := jsonb_build_object(
         'start_date', (current_date - 7)::text,
         'end_date',   current_date::text,
         'max_days',   5),
       timeout_milliseconds := 280000
     ); $$
);
