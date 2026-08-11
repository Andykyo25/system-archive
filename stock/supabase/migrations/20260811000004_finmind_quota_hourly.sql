-- FinMind 配額模型修正:600 是「每小時」不是「每天」(2026-08-11)
--
-- 實測 https://api.web.finmindtrade.com/v2/user_info(兩顆 token 回傳一致):
--   "api_request_limit_hour": 600
--   "api_request_limit_day":  "-"     ← 沒有日上限
--
-- 而 api_quota_state 從 B1(increment_quota)起就把它當「每天 600」在 gate:
-- EF 進來先讀 (source, quota_date = 今天) 的 used,>= 600 就 return quota_exhausted。
-- 後果是系統每天自己把自己關掉,/health 上這幾條紅燈全是**自己 gate 掉的**,
-- 不是 FinMind 擋的:
--   finmind_valuation      quota exhausted at 00406A
--   finmind_fundamentals   quota exhausted at 00798B
--   finmind_margin         quota exhausted at 2891
--   backfill_corporate_action  quota exhausted at 00719B
--   finmind_institutional / finmind_lending  → 連 fetch_log 都沒寫就 return,整列從監控消失
-- 診斷當下兩顆 token 直接打 TaiwanStockPrice/2408 都回 200,token 本身是好的。
--
-- 修法:不動任何 EF。EF 讀寫的是 api_quota_state.used,只要讓這個計數器每個整點
-- 歸零,「日計數器」就變成「時計數器」—— 語意直接對齊 FinMind 的真實限制,
-- budget 600 也從錯的日上限變成對的時上限。13 個 EF 一行都不用改、不用重 deploy。
--
-- 為什麼不是把 budget 改大:改大只是把牆往後推,而且會弄丟「同一小時內連打 600 次」
-- 的保護 —— 那才是 FinMind 真正會回 400 的情境。歸零式才是正確模型。
--
-- 視窗對齊:FinMind 的計數視窗是整點對齊的(07:30 UTC 那批呼叫累到 586,
-- 07:45 查 user_count = 587 = 同一個整點視窗內),所以 cron 排 '0 * * * *'。
--
-- 副作用:api_quota_state.used 不再是「今日累計」而是「本小時累計」。
--   v_data_health 的 quota 標籤同步改(20260811000006)。
--   要回查日用量改看 fetch_log / EF response 的 api_calls。
--
-- rollback:select cron.unschedule('reset-finmind-hourly-quota');
--           unschedule 後 used 自然回到日累計,行為即刻復原成現狀。

select cron.schedule(
  'reset-finmind-hourly-quota',
  '0 * * * *',
  $$ update public.api_quota_state
        set used = 0
      where quota_date = current_date
        and used > 0 $$
);
