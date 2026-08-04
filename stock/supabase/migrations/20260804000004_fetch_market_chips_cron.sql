-- fetch-market-chips 每日排程(M10 Phase 1,2026-08-04)
--
-- 時點:13:30 UTC = 21:30 Taipei,平日。三個來源的公布時間都在此之前:
--   期交所三大法人(含未平倉)約 15:00、證交所三大法人買賣超約 16:00、
--   融資融券餘額約 21:00(最晚的一個)。21:30 跑確保當日三者都已定案。
--
-- 不帶 body → EF 預設抓近 14 個日曆日,連假/單日失敗都會在隔天自動補回
-- (upsert cache 語意,重抓無副作用)。這是對 [[L42]]/[[L46]] 沉默 drift 的被動防線;
-- 主動防線是 v_data_health 已納入 market_chips_daily 新鮮度(20260804000003)。
--
-- 此 EF 免 FinMind token、每次只花 3 個 API call,不參與 finmind/finmind_2 的
-- quota 先到先得競爭([[L55]]),故排程時點不需避讓其他 finmind_* EF。

select cron.schedule(
  'fetch-market-chips-daily',
  '30 13 * * 1-5',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-market-chips',
       headers := jsonb_build_object(
         'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
         'Content-Type','application/json'),
       body := '{}'::jsonb,
       timeout_milliseconds := 120000
     ); $$
);
