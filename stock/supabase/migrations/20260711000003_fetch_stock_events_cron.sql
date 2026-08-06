-- fetch-stock-events 每日排程(規畫④B 2026-07-11)
-- 21:30 Taipei = 13:30 UTC 每日(含假日,API 冪等無妨;t187ap04 當日重大訊息晚間已完整)
select cron.schedule(
  'fetch-stock-events',
  '30 13 * * *',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-stock-events',
       headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),'Content-Type','application/json'),
       body := '{}'::jsonb,
       timeout_milliseconds := 60000
     ); $$
);
