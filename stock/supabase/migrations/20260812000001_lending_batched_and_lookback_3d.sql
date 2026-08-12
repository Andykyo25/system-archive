-- lending 分批 + margin/lending 回看視窗 8 天 → 3 天(2026-08-12)
--
-- 承 20260811000008(margin/lending 改走 backfill EF 避開 150 秒 wall-clock)。
-- 那一版還不夠 —— lending 即使走 backfill EF、178 檔仍然 546:
--   batch1(offset 0,60 檔)  1094 列  ✓
--   batch2(offset 60,60 檔)  825 列  ✓
--   batch3(offset 120,60 檔) 爆掉    ✗
-- **瓶頸是「檔數 × 天數 × 每檔每日列數」的乘積**,而不同區段的股票每檔列數差很多,
-- 光靠固定檔數切不安全。日更只需要覆蓋週末缺口,把回看 8 天改 3 天後,
-- 同一批(offset 120)58 檔只剩 222 列、0 errors 通過。
--
-- 所以兩件事一起做:lending 拆 4 批 × 60(offset 0/60/120/180,預留 universe 長到 240),
-- margin 與 lending 的回看都改 3 天(冪等,重跑無害)。
-- 4×60 = 240 calls/小時,加 09:00 institutional 178 仍 < 600(FinMind 600/滾動小時)。
--
-- rollback:lending b2/b3/b4 unschedule、b1 改回不帶 symbol_offset/limit;
--           兩處 (current_date - 3) 改回 (current_date - 8)。

select cron.schedule(
  'fetch-finmind-margin-daily',
  '5 9 * * 1-5',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
       headers := jsonb_build_object(
         'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
         'Content-Type','application/json'),
       body := jsonb_build_object(
         'dataset','margin',
         'start_date',(current_date - 3)::text,
         'end_date',current_date::text,
         'symbols',(select jsonb_agg(symbol order by symbol) from public.v_fetch_universe_stocks),
         'token_key','finmind_token_2'),
       timeout_milliseconds := 300000); $$
);

select cron.unschedule('fetch-finmind-lending-daily');

do $mig$
declare
  i int;
  names text[] := array['b1','b2','b3','b4'];
  mins  int[]  := array[10, 15, 20, 25];
  offs  int[]  := array[0, 60, 120, 180];
begin
  for i in 1..4 loop
    perform cron.schedule(
      'fetch-finmind-lending-' || names[i],
      mins[i] || ' 9 * * 1-5',
      format($cmd$ select net.http_post(
           url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
           headers := jsonb_build_object(
             'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
             'Content-Type','application/json'),
           body := jsonb_build_object(
             'dataset','lending',
             'start_date',(current_date - 3)::text,
             'end_date',current_date::text,
             'symbols',(select jsonb_agg(symbol order by symbol) from public.v_fetch_universe_stocks),
             'symbol_offset',%s,'symbol_limit',60),
           timeout_milliseconds := 300000); $cmd$, offs[i])
    );
  end loop;
end
$mig$;
