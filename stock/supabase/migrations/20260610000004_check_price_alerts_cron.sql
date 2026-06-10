-- check-price-alerts 盤中排程(2026-06-10,「好股等好價」工程 D)
-- 每 10 分比價 alert_rules vs v_latest_price_realtime(零外部 API quota)。
-- */10 1-5 UTC 平日 = 09:00~13:50 Taipei(台股盤中)。

select cron.schedule(
  'check-price-alerts',
  '*/10 1-5 * * 1-5',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/check-price-alerts',
       headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),'Content-Type','application/json'),
       body := '{}'::jsonb,
       timeout_milliseconds := 30000
     ); $$
);
