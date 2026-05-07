-- 排程 fetch-finmind-fallback Edge Function:平日 16:00 Taipei (UTC 08:00)
-- 主力 14:30 之後 1.5 hr 觸發,給主力時間先寫入今天的 row(避免 fallback 搶先 lock)

select cron.schedule(
  'fetch-finmind-fallback',
  '0 8 * * 1-5',
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-fallback',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 60000
  );
  $$
);
