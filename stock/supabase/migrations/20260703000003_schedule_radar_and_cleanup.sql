-- B 工程 cron(2026-07-03):熱股雷達 + 90 日滾動清理
--
-- 雷達:平日 14:20 UTC(= Taipei 22:20,晚場 fetch-daily-prices-evening 14:00 UTC 後)。
--   scan_hot_stocks() 晉升熱股 → 對新晉 symbols 觸發 fetch-finmind-backfill
--   (token2)補 3 年 price + fundamentals + monthly_revenue + valuation(一次性 snapshot;
--   之後日常價格走全市場免費源,chip 不日更 → v_factor_scores 缺維 reallocate,L23)。
-- 清理:每日 20:10 UTC。只清從未進過任何池的全市場股 >135 日曆天。
--
-- rollback:select cron.unschedule('scan-hot-stocks'); select cron.unschedule('cleanup-market-prices');

select cron.schedule(
  'scan-hot-stocks',
  '20 14 * * 1-5',
  $$
  do $body$
  declare
    syms text[];
    ds text;
  begin
    select public.scan_hot_stocks() into syms;
    if syms is not null and array_length(syms, 1) > 0 then
      foreach ds in array array['price', 'fundamentals', 'monthly_revenue', 'valuation']
      loop
        perform net.http_post(
          url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
            'Content-Type', 'application/json'
          ),
          body := jsonb_build_object(
            'dataset', ds,
            'start_date', to_char(current_date - interval '3 years', 'YYYY-MM-DD'),
            'symbols', to_jsonb(syms),
            'token_key', 'finmind_token_2'
          ),
          timeout_milliseconds := 600000
        );
      end loop;
    end if;
  end
  $body$;
  $$
);

select cron.schedule(
  'cleanup-market-prices',
  '10 20 * * *',
  $$ select public.cleanup_market_prices(); $$
);
