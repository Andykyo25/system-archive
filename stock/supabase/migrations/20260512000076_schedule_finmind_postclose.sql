-- M9.3+: 收盤後 finmind-fallback cron
--
-- 問題:13:30 收盤 → 13:55 yahoo MIS 最後一輪 → 14:25 (30 min cache window) 失效
-- → 之後 UI 顯示 fallback 到「twse_yesterday」昨日收盤
-- → 直到 16:00 既有 fetch-finmind-fallback cron 跑完才會更新
-- → 但 14:25-16:00 之間使用者看不到當日收盤(空檔 ~95 分鐘)
--
-- 解法:加 15:30 Taipei trigger,FinMind 通常 15:00+ 有當日 close 就緒
-- finmind 寫入 source='finmind' is_provisional=true → v_latest_price_realtime 內
-- daily_today CTE 命中(因為 trade_date=current_date)→ UI 立刻顯示今日收盤
-- 標籤帶「provisional · finmind」警示
-- 22:00 TWSE 主力 cron 跑時用「主力可覆蓋 provisional」邏輯(L17)升級成 final
--
-- 跟既有 16:00 fetch-finmind-fallback-daily 是 redundant 但 idempotent:
--   - first-write-wins(L11)→ 同一筆 row 不會被覆寫
--   - 額外 quota cost:30 個 symbol × 1 call = ~30 quota/天
--   - 但是 FinMind 也支援 batch,實際可能更省

do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'fetch-finmind-fallback-postclose';
exception when others then null;
end $$;

select cron.schedule(
  'fetch-finmind-fallback-postclose',
  '30 7 * * 1-5',
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-fallback',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
      'Content-Type','application/json'
    ),
    timeout_milliseconds := 120000
  );
  $$
);
