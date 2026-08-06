-- ============================================================
--  Supabase pg_cron 設定：每日早上 9:00（台灣時間）推播 LINE
--  在 Supabase Dashboard → SQL Editor 執行此檔案
-- ============================================================

-- Step 1: 啟用必要擴充套件
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Step 2: 建立排程
--   cron 時間為 UTC，台灣 UTC+8，早上 09:00 = UTC 01:00
--   格式：分 時 日 月 星期
SELECT cron.schedule(
  'line-notify-daily',      -- 排程名稱（唯一）
  '0 1 * * *',              -- 每天 01:00 UTC = 09:00 台灣時間
  $$
  SELECT net.http_post(
    url     := 'https://legwqtrutzpbwqumvvkb.supabase.co/functions/v1/line-notify',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || '【替換成你的 CRON_SECRET】'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);

-- ── 驗證排程已建立 ──
SELECT jobid, jobname, schedule, command
FROM cron.job
WHERE jobname = 'line-notify-daily';

-- ============================================================
--  常用管理指令（需要時再執行）
-- ============================================================

-- 查看所有排程
-- SELECT * FROM cron.job;

-- 查看最近執行紀錄
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- 修改排程時間（例如改為 08:30 台灣時間 = 00:30 UTC）
-- SELECT cron.unschedule('line-notify-daily');
-- 然後重新執行 Step 2，修改 cron 表達式

-- 暫停排程
-- UPDATE cron.job SET active = false WHERE jobname = 'line-notify-daily';

-- 恢復排程
-- UPDATE cron.job SET active = true WHERE jobname = 'line-notify-daily';

-- 刪除排程
-- SELECT cron.unschedule('line-notify-daily');
