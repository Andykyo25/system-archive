-- FinMind quota 再平衡:margin / monthly_revenue 改走 token_2
--
-- 問題(2026-07-22 由 fetch_log 盤點發現):
--   主 token(finmind)7/19-7/21 連 3 天 600/600 用滿,備援 token_2 僅 150-309/600 閒置。
--   quota 先到先得 → cron 排在後面的 EF 直接 quota_exhausted:
--     - finmind_margin(09:05,排在 valuation 08:30 / institutional 09:00 之後)近 5 次全失敗
--       → stock_margin stale 2 天,籌碼因子(chip_margin_drop / margin_balance_latest)用過期資料
--     - finmind_monthly_revenue(週日 20:00,當日最後)亦 quota_exhausted
--   這是 L42/L46 沉默 drift 第三次重演:系統「看起來在跑」,實際靜靜停止收料。
--
-- 修法:沿用 fetch-finmind-lending 既有的 token_key body 參數 pattern(零新機制)。
--   EF 端已於同批部署支援(margin v4 / monthly-revenue v4):
--     body.token_key='finmind_token_2' → read_finmind_token_2 RPC + quota source 'finmind_2'
--   本 migration 只改 cron 呼叫時多帶 body,不動 schedule、不動 schema。
--
-- 實測(2026-07-22 手動 pg_net 觸發 margin 帶 token_2):
--   success=true / rows_written=1001 / stock_margin max(trade_date) 7-20 → 7-21 /
--   quota 正確記在 finmind_2(1 → 150),finmind 未被動用。
--
-- 註:這是手動負載分配,不是自動 failover。若未來 token_2 也開始吃緊,
--     正解是做 pick_finmind_quota() RPC 讓 EF 自動選有餘額的 token(見 tasks/todo.md)。

do $$
declare
  jid bigint;
begin
  -- 1) fetch-finmind-margin-daily(平日 09:05 UTC = 17:05 Taipei)
  select jobid into jid from cron.job where jobname = 'fetch-finmind-margin-daily';
  if jid is null then
    raise exception 'cron job fetch-finmind-margin-daily not found';
  end if;
  perform cron.alter_job(
    job_id := jid,
    command := $cmd$select net.http_post(
  url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-margin',
  headers := jsonb_build_object(
    'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
    'Content-Type','application/json'),
  body := jsonb_build_object('token_key','finmind_token_2'),
  timeout_milliseconds := 300000);$cmd$
  );

  -- 2) fetch-finmind-monthly-revenue-weekly(週日 20:00 UTC)
  select jobid into jid from cron.job where jobname = 'fetch-finmind-monthly-revenue-weekly';
  if jid is null then
    raise exception 'cron job fetch-finmind-monthly-revenue-weekly not found';
  end if;
  perform cron.alter_job(
    job_id := jid,
    command := $cmd$select net.http_post(
  url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-monthly-revenue',
  headers := jsonb_build_object(
    'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
    'Content-Type','application/json'),
  body := jsonb_build_object('token_key','finmind_token_2'),
  timeout_milliseconds := 300000);$cmd$
  );
end $$;
