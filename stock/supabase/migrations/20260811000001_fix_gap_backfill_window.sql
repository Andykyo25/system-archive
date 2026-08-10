-- 補洞 cron 視窗修正:讓它補得到「最新交易日」(2026-08-11)
--
-- Bug:20260806000004 送 start_date = current_date - 7 搭 max_days = 5,
-- 而 backfill-market-history 是「從 start_date 往後數 max_days 個**工作日**就停」。
-- current_date - 7 與 current_date 同一個星期幾 → 前 5 個工作日必定落在 3-7 天前,
-- **永遠碰不到最新交易日**。實測 2026-08-10 06:45 那次補的是 8/03–8/07,
-- next_start 停在 8/10 就結束。註解寫「補最近 5 天」,實際是「7 天前起算的 5 天」。
--
-- 後果:8/10 的洞當天沒補到 → 07:00 freeze-scan-picks 凍到只有 524 檔的殘缺池
-- (正常約 2300)= L60 重演。這也是 /health 上 coverage 亮紅的直接原因之一。
--
-- 修法:start_date 改 current_date - 5。任何 6 天視窗(d-5..d)最多含 5 個工作日
-- (上界是 Mon..Sat 那種排法),所以 max_days = 5 剛好走得到 current_date,
-- 不必加大上限、不增加對上游的 call 數(仍是 5 天 × 2 市場 = 10 calls)。
--
-- 其餘參數與 20260806000004 完全相同(append-only replace,L37)。
--
-- rollback:把下面的 (current_date - 5) 改回 (current_date - 7),重跑本檔。

select cron.schedule(
  'backfill-market-history-daily',
  '45 6 * * 1-6',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/backfill-market-history',
       headers := jsonb_build_object(
         'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
         'Content-Type','application/json'),
       body := jsonb_build_object(
         'start_date', (current_date - 5)::text,
         'end_date',   current_date::text,
         'max_days',   5),
       timeout_milliseconds := 280000
     ); $$
);
