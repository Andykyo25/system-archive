-- 排程兩個 FinMind 基本面相關 EF
-- 1. fundamentals(季報):每週一 03:00 Taipei = Sunday 19:00 UTC,財報變動慢
-- 2. valuation(PE/PB):每天 16:30 Taipei = UTC 08:30,在 finmind-fallback (16:00) 之後

select cron.schedule(
  'fetch-finmind-fundamentals-weekly',
  '0 19 * * 0',
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-fundamentals',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 300000
  );
  $$
);

select cron.schedule(
  'fetch-finmind-valuation-daily',
  '30 8 * * 1-5',
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-valuation',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 60000
  );
  $$
);
