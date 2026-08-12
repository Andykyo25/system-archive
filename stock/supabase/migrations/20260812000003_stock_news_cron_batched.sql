-- fetch-stock-news 分批(2026-08-12)
--
-- 同一道 150 秒 wall-clock。本 EF 每檔約 0.2 秒(SYMBOL_THROTTLE_MS 80ms + RSS 往返),
-- universe 從 547 長到 594 就整批過牆:最後一次成功是 8/06 06:00 花了 110 秒,
-- 之後每 6 小時觸發一次、每次 546 被砍,fetch_log 全停在 success is null(開了沒收尾)。
-- 舊版 v_data_health 的 fail_n 用 `not success`,null 兩邊都不算 → 它在 /health 上一直是綠的,
-- 是本輪 stuck_n 才抓到(近 7 天 20 次沒收尾)。
--
-- EF v3 加了 symbol_offset / symbol_limit(與 fetch-finmind-backfill 同名),
-- 不傳 = 全跑(退版安全)。實測 v3 跑 200 檔 = 84 秒 success=true —— 8/06 以來第一次成功。
-- 594 檔換算約 250 秒,所以切 4 批 × 150(約 63 秒/批),同時段內錯開 3 分鐘不重疊。
--
-- ⚠ 第 4 批 offset 450 覆蓋到 600 檔。universe 再長就要再加批,否則超出的部分靜默漏收
--   —— 這正是本 EF 一開始出事的同一種成長。
-- 另:retention 清理只在 offset=0 那批做(與 symbol 無關,分批後每批都跑等於做 4 次)。
--
-- rollback:unschedule b2/b3/b4,b1 改回 '0 */6 * * *' 且不帶 body。

select cron.unschedule('fetch-stock-news-6h');

do $mig$
declare
  i int;
  names text[] := array['b1','b2','b3','b4'];
  mins  int[]  := array[0, 3, 6, 9];
  offs  int[]  := array[0, 150, 300, 450];
begin
  for i in 1..4 loop
    perform cron.schedule(
      'fetch-stock-news-' || names[i],
      mins[i] || ' */6 * * *',
      format($cmd$ select net.http_post(
           url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-stock-news',
           headers := jsonb_build_object(
             'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
             'Content-Type','application/json'),
           body := jsonb_build_object('symbol_offset',%s,'symbol_limit',150),
           timeout_milliseconds := 200000); $cmd$, offs[i])
    );
  end loop;
end
$mig$;
