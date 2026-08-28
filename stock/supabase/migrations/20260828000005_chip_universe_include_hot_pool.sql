-- 籌碼收料 universe 納入熱股池(2026-08-28)
--
-- 問題(活的 [[L44]]):`universe_dynamic` 50 檔 active 熱股**已經進入排名計算**
-- (v_price_factors / v_chip_factors / score_universe_at 都吃它),但 0/50 在
-- v_fetch_universe_stocks 裡 → 籌碼日更完全不收:
--   法人 1/50、融資券 1/50、借券 1/50、外資持股 0/50
-- 結果 mv_factor_scores 583 檔中 **409 檔(70.2%)chip_count_total = 0**,
-- 籌碼 20% 權重對七成標的是空轉分母。「邏輯一致但歷史資料覆蓋不一致」的教科書案例。
--
-- ⚠ 為什麼不直接擴 v_fetch_universe_stocks(原計畫寫的做法,實作時推翻):
-- 那張 view 被 **10 支 EF** 讀,其中 `fetch-finmind-fundamentals` 在 178 檔時已是
-- 178 × 3 dataset = 534 calls = FinMind 滾動小時配額的 89%。擴到 228 檔 → 684 calls
-- **直接爆 600 上限**。而該 EF **完全不吃 body 參數**(cron 只送 auth header,名單在函式內部查),
-- 所以沒辦法只改 cron 拆批,得改 EF 再 deploy —— 超出「一行 view」的範圍。
-- `fetch-stock-news` 同理會需要第 5 批(現行 4 批 × 150 只覆蓋到 600)。
--
-- 而實際缺口本來就只有籌碼:熱股池的 fundamentals 已有 41/50、monthly_revenue 50/50。
-- 所以開一張**只給籌碼四 dataset 用**的 view,blast radius 從 10 支 EF 縮到 4 支。
--
-- 配額檢查(滾動 600/小時/token):
--   token_1 09:00-09:30 窗:institutional 228 + lending 228 = 456 ✅
--   token_2:margin 228 ✅ / 週日 01:00 shareholding b4 48 ✅
--
-- rollback:
--   1. do $$ 迴圈把 4 支 cron 的 v_fetch_chip_universe 換回 v_fetch_universe_stocks
--   2. cron.unschedule('fetch-finmind-institutional-b1'/'-b2'/'fetch-finmind-shareholding-b4')
--   3. 重建 fetch-finmind-institutional-daily(原指令保留在本檔註解末尾)
--   4. drop view public.v_fetch_chip_universe;

create or replace view public.v_fetch_chip_universe as
select symbol from public.v_fetch_universe_stocks
union
select symbol from public.universe_dynamic where active;

comment on view public.v_fetch_chip_universe is
  '籌碼類 dataset(institutional / margin / lending / shareholding)專用的收料名單 = '
  '基礎 universe + 熱股池 active。刻意與 v_fetch_universe_stocks 分開:'
  'fundamentals / valuation / news 若跟著擴會撞 FinMind 小時配額與 EF wall-clock。';

-- 既有籌碼 cron 改讀新 view。用字串替換而非重寫指令,確保 token_key / lookback / offset
-- 等既有參數一字不動([[L46]] 不憑記憶重打)
do $$
declare j record;
begin
  for j in
    select jobid, command from cron.job
    where jobname in (
      'fetch-finmind-margin-daily',
      'fetch-finmind-lending-b1','fetch-finmind-lending-b2',
      'fetch-finmind-lending-b3','fetch-finmind-lending-b4',
      'fetch-finmind-shareholding-b1','fetch-finmind-shareholding-b2',
      'fetch-finmind-shareholding-b3')
      and command like '%v_fetch_universe_stocks%'
  loop
    perform cron.alter_job(j.jobid,
      command := replace(j.command,
                         'public.v_fetch_universe_stocks',
                         'public.v_fetch_chip_universe'));
  end loop;
end $$;

-- institutional:178 檔已跑 80.4 秒(150 秒牆的 54%),228 檔外推 ~103 秒 → 必須拆 2 批
select cron.unschedule('fetch-finmind-institutional-daily');

select cron.schedule('fetch-finmind-institutional-b1', '0 9 * * 1-5', $job$
 select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
       headers := jsonb_build_object(
         'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
         'Content-Type','application/json'),
       body := jsonb_build_object(
         'dataset','institutional',
         'start_date',(current_date - 3)::text,
         'end_date',current_date::text,
         'symbols',(select jsonb_agg(symbol order by symbol) from public.v_fetch_chip_universe),
         'symbol_offset',0,'symbol_limit',120),
       timeout_milliseconds := 300000);
$job$);

select cron.schedule('fetch-finmind-institutional-b2', '30 9 * * 1-5', $job$
 select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
       headers := jsonb_build_object(
         'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
         'Content-Type','application/json'),
       body := jsonb_build_object(
         'dataset','institutional',
         'start_date',(current_date - 3)::text,
         'end_date',current_date::text,
         'symbols',(select jsonb_agg(symbol order by symbol) from public.v_fetch_chip_universe),
         'symbol_offset',120,'symbol_limit',120),
       timeout_milliseconds := 300000);
$job$);

-- shareholding 原本 b1-b3 × 60 只覆蓋到 offset 180;228 檔會漏掉最後 48 檔 → 補 b4。
-- 排在週日 01:00 而非週六:週六 19-23 點已被 shareholding b1-b3 與 corporate_action b1-b3
-- 塞滿(後者 1,190 calls 已在吃 402)。shareholding 回看 14 天,晚一天無影響。
select cron.schedule('fetch-finmind-shareholding-b4', '0 1 * * 0', $job$
 select net.http_post(
           url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
           headers := jsonb_build_object(
             'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
             'Content-Type','application/json'),
           body := jsonb_build_object(
             'dataset','shareholding',
             'start_date',(current_date - 14)::text,
             'end_date',current_date::text,
             'symbols',(select jsonb_agg(symbol order by symbol) from public.v_fetch_chip_universe),
             'symbol_offset',180,'symbol_limit',60,
             'token_key','finmind_token_2'),
           timeout_milliseconds := 300000);
$job$);

-- 監控:新 source 名沒變(仍是 backfill_institutional 等),期望清單不需異動
--
-- rollback 用的原始 institutional 指令:
--   schedule '0 9 * * 1-5',body 同 b1 但無 symbol_offset / symbol_limit,
--   symbols 取自 public.v_fetch_universe_stocks
