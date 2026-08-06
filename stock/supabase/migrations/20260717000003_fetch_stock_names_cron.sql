-- fetch-stock-names 週更排程(每週日 20:30 Taipei = 12:30 UTC)
select cron.schedule(
  'fetch-stock-names',
  '30 12 * * 0',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-stock-names',
       headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),'Content-Type','application/json'),
       body := '{}'::jsonb,
       timeout_milliseconds := 60000
     ); $$
);
