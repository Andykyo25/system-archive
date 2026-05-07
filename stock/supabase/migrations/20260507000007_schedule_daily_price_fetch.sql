-- 排程 fetch-daily-prices Edge Function:平日台股盤後 14:30 (UTC 06:30)
--
-- 前置:vault secret 'edge_function_auth' 必須先建立(內含 service_role JWT)
-- 不放在 migration 內,避免 JWT 進版本歷史。手動建立指令:
--   select vault.create_secret(
--     '<service_role_jwt>',
--     'edge_function_auth',
--     'Bearer JWT for fetch-daily-prices Edge Function (used by pg_cron)'
--   );

select cron.schedule(
  'fetch-daily-prices',
  '30 6 * * 1-5',  -- 14:30 Taipei (06:30 UTC), weekdays
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-daily-prices',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 60000
  );
  $$
);
