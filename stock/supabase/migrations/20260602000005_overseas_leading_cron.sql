-- 海外領先 EF 盤前排程(2026-06-02,階段 0)
--
-- fetch-overseas-leading range=5d(即時模式):盤前抓兩次 —
--   06:30 Taipei(22:30 UTC 週日~四):美股已收,昨夜定案
--   08:30 Taipei(00:30 UTC 週一~五):台股開盤前,NQ 期貨最新情緒
-- pg_net + vault edge_function_auth(同既有 EF cron pattern)。
-- 歷史回填(range=2y)為一次性手動 invoke,不在 cron。

select cron.schedule(
  'fetch-overseas-leading-am',
  '30 22 * * 0-4',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-overseas-leading',
       headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),'Content-Type','application/json'),
       body := jsonb_build_object('range','5d'),
       timeout_milliseconds := 60000
     ); $$
);
select cron.schedule(
  'fetch-overseas-leading-open',
  '30 0 * * 1-5',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-overseas-leading',
       headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),'Content-Type','application/json'),
       body := jsonb_build_object('range','5d'),
       timeout_milliseconds := 60000
     ); $$
);
