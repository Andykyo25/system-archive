-- Phase 0 收尾補強:每週自動抓新 corporate_action(2026-05-16)
--
-- 背景:adj_factor 靠 stock_corporate_action 回算。該表原本只有人工
--   一次性歷史 backfill,沒有定期抓「新發生」的除權息/分割 → 台股每年
--   7~9 月一批除息後,若無人手動補,adj_factor 會過時,backtest/選股
--   歷史價在新除息日又出現假性跳水(Phase 0 問題對「未來新增」復發)。
--
-- 解法:每週排程呼叫 fetch-finmind-backfill(dataset=corporate_action,
--   回看 60 天,全 universe,token_2 獨立 quota)。該 EF 寫入後會
--   自動 recompute_adj_factor()(20260515000004 前一批收尾已內嵌),
--   故整條鏈全自動,不需人工。
--
-- 量級:~154 syms × 2 call = ~308 call/週(0.2 全量實測 11s),
--   token_2 各日 600 額度,遠低於上限,不影響日常抓價(token_1)。
--
-- 時段:pg_cron 走 UTC。週六 21:00 UTC = 週日 05:00 Taipei(凌晨離峰)。
--   避開既有週末 finmind 排程(六 19:00 集保 / 六 20:00 ETF /
--   日 19:00 fundamentals / 日 20:00 月營收)。
--
-- idempotent:jobname 已存在先 unschedule 再 schedule(對齊既有風格)。

select cron.unschedule(jobid)
from cron.job where jobname = 'fetch-corporate-action-weekly';

select cron.schedule(
  'fetch-corporate-action-weekly',
  '0 21 * * 6',  -- 週六 UTC 21:00 = 週日 05:00 Taipei
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'dataset', 'corporate_action',
      'start_date', to_char(current_date - interval '60 days', 'YYYY-MM-DD'),
      'token_key', 'finmind_token_2'
    ),
    timeout_milliseconds := 600000
  );
  $$
);
