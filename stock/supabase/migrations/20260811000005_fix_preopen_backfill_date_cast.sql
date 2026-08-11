-- holdings 盤前補洞 cron:start_date 型別 bug + 空持股炸全 universe(2026-08-11)
--
-- Bug 1(HTTP 400 的真兇):body 送 (current_date - interval '3 days')::text。
--   date - interval → timestamp,::text 得到 '2026-08-08 00:00:00'。
--   FinMind 的 start_date 只吃 'YYYY-MM-DD',帶時間就回 HTTP 400。
--   date - int 才是 date:(current_date - 3)::text = '2026-08-08'。
--   同一支 cron 的 end_date 用 current_date::text 一直是對的,所以只有 start 壞。
--   → /health 上 backfill_price「2408: HTTP 400」就是這個(2408 是唯一持股)。
--   這條是 L46 的防護層 ——「即使 fallback 又漏,持股一定有資料」——
--   自 20260521 建立起沒成功過一次,防護層一直是空的。
--
-- Bug 2:v_holdings_current 為空時 jsonb_agg 給 '[]',fetch-finmind-backfill 收到
--   空陣列會退回「全 universe」(594 檔 × price)。8/07、8/10 那兩筆整串 HTTP 400
--   就是這樣來的 —— 空手時反而打最兇。加 where exists 讓它直接不發。
--
-- 其餘參數與 20260521 原 cron 完全相同(append-only replace,L37)。
--
-- rollback:把 (current_date - 3) 改回 (current_date - interval '3 days')、
--           拿掉 where exists,重跑本檔。

select cron.schedule(
  'holdings-staleness-backfill-preopen',
  '45 0 * * 1-5',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
         'Content-Type','application/json'),
       body := jsonb_build_object(
         'dataset','price',
         'symbols', (select coalesce(jsonb_agg(symbol order by symbol), '[]'::jsonb) from public.v_holdings_current),
         'start_date', (current_date - 3)::text,
         'end_date', current_date::text,
         'token_key','finmind_token_2'),
       timeout_milliseconds := 600000
     )
     where exists (select 1 from public.v_holdings_current); $$
);
