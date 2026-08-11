-- FinMind cron 依「每滾動小時 600」重新排(2026-08-11)
--
-- 前提(20260811000004 的實證,再加一條當場量到的硬證據):
--   手動觸發 fetch-finmind-valuation(已砍 ETF,178 檔)→ 只成功 22 檔就開始
--   **HTTP 402**,因為 07:30 那批 586 次還在滾動視窗內(586 + 22 ≈ 608 > 600)。
--   → FinMind 的限流回應是 402,視窗是「滾動 1 小時」不是「整點歸零」。
--
-- 因此真正要管的不是「一天幾次」,是「任何連續 60 分鐘內同一顆 token 幾次」。
-- 本檔把 token_1 的日排程拉開,讓任何 60 分鐘視窗都在 600 以內:
--
--   07:30  fetch-finmind-fallback        ≤594   (視窗 07:30–08:30)
--   09:00  fetch-finmind-institutional    178 ┐  (視窗 09:00–10:10 合計 356)
--   09:10  fetch-finmind-lending          178 ┘
--   10:30  fetch-finmind-valuation        178    ← 從 08:30 移來
--
-- 移 valuation 的理由:它原本排 08:30,剛好卡在 fallback(07:30)滾動視窗的邊界上,
-- 是最容易互撞的一支;而 PE/PB 是日頻因子,晚兩小時進來對 /rank /holdings 無影響。
-- (另一個選項是把 fallback 移到 14:30 UTC —— 那是 tasks/todo.md 既有的待驗項,
--  需要先看它 already_covered 的實數,本檔不動它。)
--
-- 第二件事:corporate_action 週更拆成 3 批。
--   全 universe ≈ 594 檔 × 2 dataset(SplitPrice + DividendResult)= 1188 次,
--   一個小時塞不下 —— 這就是「quota exhausted at 00719B」的成因
--   (EF 的預設順序是 holdings→watchlist→industry→universe→**etf 最後**,
--    所以個股其實有跑完 141 列,死的是 ETF 尾段)。
--   用 EF 既有的 symbol_offset / symbol_limit 切成 200 檔一批 = 每批 400 次,
--   排在 21/22/23 點各一批。EF 寫入後會自己 recompute_adj_factor(),重跑冪等。
--
-- rollback:valuation 改回 '30 8 * * 1-5';
--           corporate_action 三批 unschedule 後重跑 20260602000002(原單批版)。

-- ① valuation 08:30 → 10:30
select cron.schedule(
  'fetch-finmind-valuation-daily',
  '30 10 * * 1-5',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-valuation',
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
         'Content-Type', 'application/json'),
       timeout_milliseconds := 280000
     ); $$
);

-- ② corporate_action 週更拆 3 批(每批 200 檔 = 400 calls,間隔 1 小時)
select cron.unschedule('fetch-corporate-action-weekly');

select cron.schedule(
  'fetch-corporate-action-weekly-b1', '0 21 * * 6',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
         'Content-Type', 'application/json'),
       body := jsonb_build_object(
         'dataset', 'corporate_action',
         'start_date', (current_date - 60)::text,
         'symbol_offset', 0, 'symbol_limit', 200,
         'token_key', 'finmind_token_2'),
       timeout_milliseconds := 600000
     ); $$
);

select cron.schedule(
  'fetch-corporate-action-weekly-b2', '0 22 * * 6',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
         'Content-Type', 'application/json'),
       body := jsonb_build_object(
         'dataset', 'corporate_action',
         'start_date', (current_date - 60)::text,
         'symbol_offset', 200, 'symbol_limit', 200,
         'token_key', 'finmind_token_2'),
       timeout_milliseconds := 600000
     ); $$
);

select cron.schedule(
  'fetch-corporate-action-weekly-b3', '0 23 * * 6',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
         'Content-Type', 'application/json'),
       body := jsonb_build_object(
         'dataset', 'corporate_action',
         'start_date', (current_date - 60)::text,
         'symbol_offset', 400, 'symbol_limit', 400,
         'token_key', 'finmind_token_2'),
       timeout_milliseconds := 600000
     ); $$
);
