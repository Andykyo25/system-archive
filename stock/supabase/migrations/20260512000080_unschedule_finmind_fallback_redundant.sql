-- 砍 16:00 Taipei (UTC 08:00) 的 fetch-finmind-fallback cron
--
-- 為什麼:
-- - 15:30 Taipei postclose 已涵蓋(migration 76 加的)
-- - 16:00 多跑一次只是 L11 first-write-wins noop,但仍會 deduct quota
-- - 省 ~30 quota/天 = 平日總用量從 ~220 降到 ~190(31% 使用率)
--
-- 留下:
-- - fetch-finmind-fallback-postclose @ 15:30 Taipei
-- - 22:00 Taipei 主力 cron(覆蓋 provisional → final)

do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'fetch-finmind-fallback';
exception when others then null;
end $$;
