-- fetch-finmind-lending 換回 token_1(2026-08-11)
--
-- 問題:margin(09:05)與 lending(09:10)都掛 token_2,而兩個 EF 各自掃滿
-- v_fetch_universe 的 594 檔 = 各 594 calls。同一顆 token 一天 600,先跑的吃飽、
-- 後跑的餓死 —— 實測 finmind_margin 停在「quota exhausted at 2891」,
-- finmind_lending 更慘:它在建 fetch_log **之前**就 return quota_exhausted,
-- 所以在 /health 上不是變紅,是**整列從監控消失**(最後一筆 log 停在 8/06)。
--
-- 20260722000001 當初把 lending 移到 token_2 的前提是「token_1 已經滿了」。
-- 那個前提在 fetch-finmind-fallback 改成「只補洞」之後不再成立:
-- fallback 原本就是吃掉 token_1 全部 594 calls 的那一個。
-- 兩顆 token 現在的日負載大致是 token_1 = margin 級(~594)、token_2 = lending 級(~594),
-- 各自獨立不再互撞。
--
-- 依賴:必須在 fetch-finmind-fallback「只補洞」那版部署之後才套,否則 token_1
-- 仍被 fallback 佔滿,等於把 lending 從一個滿的 token 搬到另一個滿的 token。
--
-- rollback:body 改回 jsonb_build_object('token_key','finmind_token_2') 重跑本檔。

select cron.schedule(
  'fetch-finmind-lending-daily',
  '10 9 * * 1-5',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-lending',
       headers := jsonb_build_object(
         'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
         'Content-Type','application/json'),
       body := '{}'::jsonb,
       timeout_milliseconds := 300000); $$
);
