-- 第二次主力抓取:平日 22:00 Taipei (UTC 14:00)
-- 因為 TWSE OpenAPI 中午看不到當日資料,這個 evening cron 嘗試補抓
-- 配合 fetch-daily-prices v4 的「主力可覆蓋 provisional」邏輯,
-- 若 TWSE 晚上更新成當日資料,fallback 寫的 provisional 會自動升級為主力

select cron.schedule(
  'fetch-daily-prices-evening',
  '0 14 * * 1-5',
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
