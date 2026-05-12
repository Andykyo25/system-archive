-- M8: cron schedule for 4 new FinMind dataset fetchers + 2 weekly + 1 monthly
--
-- 時區換算備忘(supabase pg_cron 跑 UTC):
--   Taipei = UTC+8
--   Taipei 17:00 = UTC 09:00
--   Taipei 週日 03:00 = UTC 週六 19:00
--   Taipei 週日 04:00 = UTC 週六 20:00
--   Taipei 1 號 11:00 = UTC 1 號 03:00(避開了 UTC 月跨日的 cron 困擾,
--                                      Taipei spec 寫 03:00,但 03:00 月初代表 Taipei 上月最後一天 19:00 UTC,
--                                      用 11:00 Taipei 較簡單,實務無交易影響)
--
-- 所有 schedule 都 idempotent:如果已存在(jobname 相同)就 unschedule 再 schedule
--
-- Edge Function deploy 必須在 cron schedule 套用前完成,不然第一輪 cron 會 502

-- 法人三大買賣超 — 每日 17:00 Taipei
select cron.unschedule(jobid)
from cron.job where jobname = 'fetch-finmind-institutional-daily';
select cron.schedule(
  'fetch-finmind-institutional-daily',
  '0 9 * * 1-5',  -- 17:00 Taipei (09:00 UTC), 平日
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-institutional',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 300000
  );
  $$
);

-- 融資融券 — 每日 17:05(錯開 5 分鐘避免 quota 同時打)
select cron.unschedule(jobid)
from cron.job where jobname = 'fetch-finmind-margin-daily';
select cron.schedule(
  'fetch-finmind-margin-daily',
  '5 9 * * 1-5',  -- 17:05 Taipei
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-margin',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 300000
  );
  $$
);

-- 借券 — 每日 17:10
select cron.unschedule(jobid)
from cron.job where jobname = 'fetch-finmind-lending-daily';
select cron.schedule(
  'fetch-finmind-lending-daily',
  '10 9 * * 1-5',
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-lending',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 300000
  );
  $$
);

-- 集保戶數(週) — 每週日 03:00 Taipei = UTC 週六 19:00
select cron.unschedule(jobid)
from cron.job where jobname = 'fetch-finmind-shareholding-weekly';
select cron.schedule(
  'fetch-finmind-shareholding-weekly',
  '0 19 * * 6',  -- 週六 UTC 19:00 = 週日 03:00 Taipei
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-shareholding',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 600000
  );
  $$
);

-- ETF metadata — 每週日 04:00 Taipei = UTC 週六 20:00
select cron.unschedule(jobid)
from cron.job where jobname = 'fetch-etf-metadata-weekly';
select cron.schedule(
  'fetch-etf-metadata-weekly',
  '0 20 * * 6',
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-etf-metadata',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 300000
  );
  $$
);

-- industry_stocks 月底自動重選 — Taipei 1 號 11:00 = UTC 1 號 03:00
-- Andy spec 說「1 號 03:00 Taipei」,實際換算需 UTC 上月底 19:00(難寫),
-- 改用 UTC 1 號 03:00(Taipei 1 號 11:00)等價於月初一次,避開所有交易時段
select cron.unschedule(jobid)
from cron.job where jobname = 'reselect-industry-stocks-monthly';
select cron.schedule(
  'reselect-industry-stocks-monthly',
  '0 3 1 * *',  -- 月 1 號 UTC 03:00 = Taipei 11:00
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/reselect-industry-stocks',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 600000
  );
  $$
);
