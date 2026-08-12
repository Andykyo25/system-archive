-- institutional / shareholding 改走 fetch-finmind-backfill(2026-08-12)
--
-- 延續 20260811000008 的同一個病因:Supabase EF wall-clock 150 秒。
--   fetch-finmind-shareholding  546  —— 17 天沒成功(週更,每次都被砍),而且因為
--                                    quota gate 在寫 fetch_log 之前 return,它在
--                                    /health 上曾經是整列消失,是本輪缺席偵測才抓到的
--   fetch-finmind-institutional 200 / 137288ms —— 過了,但只剩 13 秒餘裕。
--                                    universe 再長一點就會步上 margin/lending 後塵
-- backfill EF 同 dataset、同目標表、批次 upsert(178 檔實測 43 秒 vs dedicated 137 秒),
-- 先搬先安全。
--
-- shareholding 是週更(TWSE 每週公布),回看 14 天涵蓋跨週;分 3 批 × 60 ——
-- 套用 20260812000001 學到的:瓶頸是「檔數 × 天數 × 每檔每日列數」的乘積,
-- 天數拉到 14 就必須把檔數壓下來。
-- institutional 是日更,回看 3 天即可,單批 178 檔(實測 43 秒有餘裕)。
--
-- fetch_log source 隨之變成 backfill_institutional / backfill_shareholding,
-- v_data_health 期望清單同步改(20260812000004)。
--
-- rollback:改回 functions/v1/fetch-finmind-{institutional,shareholding} 無 body,
--           期望清單改回 finmind_institutional / finmind_shareholding。

select cron.schedule(
  'fetch-finmind-institutional-daily',
  '0 9 * * 1-5',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
       headers := jsonb_build_object(
         'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
         'Content-Type','application/json'),
       body := jsonb_build_object(
         'dataset','institutional',
         'start_date',(current_date - 3)::text,
         'end_date',current_date::text,
         'symbols',(select jsonb_agg(symbol order by symbol) from public.v_fetch_universe_stocks)),
       timeout_milliseconds := 300000); $$
);

select cron.unschedule('fetch-finmind-shareholding-weekly');

do $mig$
declare
  i int;
  names text[] := array['b1','b2','b3'];
  hrs   int[]  := array[19, 20, 21];
  offs  int[]  := array[0, 60, 120];
begin
  for i in 1..3 loop
    perform cron.schedule(
      'fetch-finmind-shareholding-' || names[i],
      '0 ' || hrs[i] || ' * * 6',
      format($cmd$ select net.http_post(
           url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
           headers := jsonb_build_object(
             'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
             'Content-Type','application/json'),
           body := jsonb_build_object(
             'dataset','shareholding',
             'start_date',(current_date - 14)::text,
             'end_date',current_date::text,
             'symbols',(select jsonb_agg(symbol order by symbol) from public.v_fetch_universe_stocks),
             'symbol_offset',%s,'symbol_limit',60,
             'token_key','finmind_token_2'),
           timeout_milliseconds := 300000); $cmd$, offs[i])
    );
  end loop;
end
$mig$;
