-- 啟用 pg_cron(排程)+ pg_net(排程內呼叫 HTTP)
-- pg_cron 用於每日盤後觸發 Edge Function fetch-daily-prices
-- pg_net 用於從 cron job 內發 HTTP POST 到 Edge Function

create extension if not exists pg_cron;
create extension if not exists pg_net;
