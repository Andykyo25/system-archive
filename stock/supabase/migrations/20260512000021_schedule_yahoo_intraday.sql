-- M8.3:排程 fetch-yahoo-intraday Edge Function
--
-- 盤中(09:00-13:55 Taipei,週一至五)每 5 分鐘抓一次 Yahoo Finance quote
-- UTC 對應 = 01:00-05:55
-- 註:13:30 是台股收盤,13:35-13:55 仍會跑(Yahoo 會回 marketState=CLOSED),
--    沒成本,反而能 capture 收盤瞬間的 last price
--
-- 前置:vault secret 'edge_function_auth' 已建立(M2 已建)

select cron.schedule(
  'fetch-yahoo-intraday-5min',
  '*/5 1-5 * * 1-5',
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-yahoo-intraday',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 120000
  );
  $$
);
