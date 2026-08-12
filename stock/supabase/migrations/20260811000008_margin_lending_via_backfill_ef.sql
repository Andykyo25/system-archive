-- margin / lending 改走 fetch-finmind-backfill,避開 150 秒 wall-clock(2026-08-11)
--
-- 實測 edge-function log(這是本輪最後一層,也是配額修好之後才浮出來的):
--   fetch-finmind-lending       546  execution_time_ms 150810
--   fetch-finmind-margin        546  execution_time_ms 150539
--   fetch-stock-news            546  execution_time_ms 150499
--   fetch-finmind-institutional 200  execution_time_ms 137288   ← 只差 13 秒
-- Supabase EF 的 wall-clock 是 **150 秒**,546 = 被砍。這幾支逐檔 EF 全部貼著牆在跑,
-- institutional 擦邊過關、margin/lending 被砍 —— 所以它們的 fetch_log 是
-- success=null(開了沒收尾),不是失敗。跟 quota 完全無關,是配額修好之後才看得見的下一層。
--
-- 而且被砍的執行**對配額是隱形的**:increment_quota 寫在迴圈之後,EF 被砍就永遠不會執行,
-- 於是那 ~150 次 call 打出去了卻沒進 api_quota_state → 下一支以為還有額度,實際撞 402。
-- (實測:09:05 margin 被砍後,09:22 的 margin backfill 178 檔有 54 個 402。)
--
-- 修法:同一組資料改叫 fetch-finmind-backfill。它打的是同一個 FinMind dataset、
-- 寫的是同一張表(stock_margin / stock_securities_lending),差別在:
--   ① 批次 upsert 而非逐檔往返 DB → 同樣 178 檔實測 **43 秒**(dedicated EF 要 137 秒)
--   ② 支援 symbol_offset / symbol_limit,未來 universe 再長也能拆
--   ③ 支援 token_key
-- 不改任何 EF 程式碼,只換 cron 指向。symbols 明確帶 v_fetch_universe_stocks
-- (不帶就會退回含 416 檔 ETF 的全 universe)。
--
-- 時段:維持 09:05 / 09:10(token_2 / token_1 分開,兩顆各自的滾動小時都很空)。
-- fetch_log 的 source 會從 finmind_margin / finmind_lending 變成
-- backfill_margin / backfill_lending → v_data_health 的期望清單同步改名,否則舊名字
-- 會永遠停在「已 N 天沒有成功紀錄」的假警報。
--
-- 未動:institutional 仍走 dedicated EF(137 秒會過,但只剩 13 秒餘裕,universe 再長就會
-- 步上後塵)。fetch-stock-news / fetch-finmind-shareholding 同樣撞 150 秒牆,本檔沒處理。
--
-- rollback:兩支 cron 改回 functions/v1/fetch-finmind-{margin,lending} + body '{}',
--           期望清單改回 finmind_margin / finmind_lending,重跑本檔。

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
         'start_date',(current_date - 8)::text,
         'end_date',current_date::text,
         'symbols',(select jsonb_agg(symbol order by symbol) from public.v_fetch_universe_stocks),
         'token_key','finmind_token_2'),
       timeout_milliseconds := 300000); $$
);

select cron.schedule(
  'fetch-finmind-lending-daily',
  '10 9 * * 1-5',
  $$ select net.http_post(
       url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
       headers := jsonb_build_object(
         'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='edge_function_auth' limit 1),
         'Content-Type','application/json'),
       body := jsonb_build_object(
         'dataset','lending',
         'start_date',(current_date - 8)::text,
         'end_date',current_date::text,
         'symbols',(select jsonb_agg(symbol order by symbol) from public.v_fetch_universe_stocks)),
       timeout_milliseconds := 300000); $$
);

-- 期望清單改名(其餘與 20260811000006 完全相同;此處只列差異行,完整定義見該檔)
create or replace view public.v_data_health as
with ref as (
  select coalesce(max(trade_date), current_date) as last_trade_date
  from public.price_daily
),
expected(source, max_age_days) as (
  values
    ('twse',                      4),
    ('tpex',                      4),
    ('finmind',                   4),
    ('finmind_valuation',         4),
    ('finmind_institutional',     4),
    ('backfill_margin',           4),
    ('backfill_lending',          4),
    ('finmind_fundamentals',     10),
    ('finmind_monthly_revenue',  10),
    ('finmind_shareholding',     10),
    ('backfill_corporate_action',10),
    ('backfill_price',            4),
    ('backfill_market_history',   3),
    ('market_chips',              4),
    ('overseas_leading',          4),
    ('twse_mis_intraday',         4),
    ('google_news',               2)
),
lastok as (
  select f.source, max(f.started_at) filter (where f.success) as last_ok_at
  from public.fetch_log f
  where f.started_at > now() - interval '60 days'
  group by f.source
),
src as (
  select
    f.source,
    count(*)                                                        as runs,
    count(*) filter (where f.success)                               as ok_n,
    count(*) filter (where not f.success)                           as fail_n,
    count(*) filter (where f.success is null
                       and f.started_at < now() - interval '30 minutes') as stuck_n,
    max(f.started_at) filter (where f.success)                      as last_ok_at,
    (array_agg(f.success order by f.started_at desc)
       filter (where f.success is not null))[1]                     as last_done_ok,
    (array_agg(f.error     order by f.started_at desc)
       filter (where not f.success))[1]                             as last_error
  from public.fetch_log f
  where f.started_at > now() - interval '7 days'
  group by f.source
),
src_j as (
  select
    coalesce(s.source, e.source)                                    as source,
    e.max_age_days,
    s.runs, s.ok_n, s.fail_n, s.stuck_n, s.last_done_ok, s.last_error,
    coalesce(s.last_ok_at, l.last_ok_at)                            as last_ok_at,
    case when l.last_ok_at is not null
      then floor(extract(epoch from (now() - l.last_ok_at)) / 86400)::int
    end                                                             as stale_days,
    (e.source is not null
       and (l.last_ok_at is null
            or l.last_ok_at < now() - make_interval(days => e.max_age_days)))
                                                                    as absent
  from src s
  full outer join expected e on e.source = s.source
  left join lastok l on l.source = coalesce(s.source, e.source)
),
src_rows as (
  select
    'source'::text as category,
    j.source       as key,
    j.source       as label,
    case
      when j.absent                           then 'danger'
      when j.runs is null                     then 'ok'
      when not coalesce(j.last_done_ok, true) then 'danger'
      when j.fail_n > 0 or j.stuck_n > 0      then 'warn'
      else 'ok'
    end::text      as level,
    (coalesce(j.fail_n, 0) + coalesce(j.stuck_n, 0))::numeric       as metric_num,
    case
      when j.absent or j.runs is null then
        coalesce('最後成功 ' || j.stale_days || ' 天前', '60 天內從未成功')
      else (j.ok_n || '/' || j.runs || ' 成功')
    end::text      as metric_text,
    case
      when j.absent then
        coalesce('已 ' || j.stale_days || ' 天沒有成功紀錄', '60 天內從未成功')
        || ' —— 這支可能安靜停擺了(cron 未觸發 / EF 在寫 fetch_log 前就 return / pg_net 沒送出)'
        || case when j.stuck_n > 0
             then ';近 7 天有 ' || j.stuck_n || ' 次開了 fetch_log 沒收尾(疑似執行逾時)' else '' end
      when j.fail_n > 0 then coalesce(left(j.last_error, 300), '(無錯誤訊息)')
      when j.stuck_n > 0 then
        '近 7 天有 ' || j.stuck_n || ' 次開了 fetch_log 沒收尾 —— EF 可能被 wall-clock 砍掉或 crash'
      else null
    end::text      as detail,
    j.last_ok_at   as last_at,
    1              as sort_group
  from src_j j
),
fresh_raw as (
  select 'price_daily'::text as tbl, '收盤價'::text as label,
         max(trade_date) as last_date, 2 as warn_d, 4 as danger_d
    from public.price_daily
  union all
  select 'stock_institutional', '法人買賣超', max(trade_date), 3, 6
    from public.stock_institutional
  union all
  select 'stock_margin', '融資融券', max(trade_date), 3, 6
    from public.stock_margin
  union all
  select 'stock_securities_lending', '借券', max(trade_date), 3, 6
    from public.stock_securities_lending
  union all
  select 'stock_pe_pb_daily', '本益比/淨值比', max(trade_date), 3, 6
    from public.stock_pe_pb_daily
  union all
  select 'overseas_indicators', '海外領先指標', max(quoted_date), 3, 6
    from public.overseas_indicators
  union all
  select 'market_chips_daily', '大盤籌碼(期貨/融資/法人)', max(trade_date), 3, 6
    from public.market_chips_daily
  union all
  select 'scan_picks', '起漲凍結樣本', max(scan_date), 5, 10
    from public.scan_picks
  union all
  select 'stock_shareholding', '外資持股比', max(report_date), 12, 20
    from public.stock_shareholding
  union all
  select 'stock_monthly_revenue', '月營收',
         max(make_date(period_year, period_month, 1)), 70, 100
    from public.stock_monthly_revenue
  union all
  select 'stock_fundamentals_quarterly', '季度財報', max(period_end), 150, 250
    from public.stock_fundamentals_quarterly
),
fresh_rows as (
  select
    'freshness'::text as category,
    fr.tbl            as key,
    fr.label          as label,
    case
      when fr.last_date is null                              then 'danger'
      when (r.last_trade_date - fr.last_date) >= fr.danger_d then 'danger'
      when (r.last_trade_date - fr.last_date) >= fr.warn_d   then 'warn'
      else 'ok'
    end::text         as level,
    (r.last_trade_date - fr.last_date)::numeric              as metric_num,
    coalesce(fr.last_date::text, '無資料')::text             as metric_text,
    case
      when fr.last_date is null then '此表沒有任何資料'
      when (r.last_trade_date - fr.last_date) >= fr.warn_d
        then '落後最新交易日 ' || (r.last_trade_date - fr.last_date) || ' 天'
      else null
    end::text         as detail,
    null::timestamptz as last_at,
    2                 as sort_group
  from fresh_raw fr cross join ref r
),
cov as (
  select trade_date, count(*)::numeric as n
  from public.price_daily
  where trade_date >= (select max(trade_date) - 20 from public.price_daily)
  group by trade_date
),
cov_stat as (
  select
    (select n from cov order by trade_date desc limit 1) as latest_n,
    (select percentile_cont(0.5) within group (order by n::float8) from cov)::numeric as median_n
),
coverage_rows as (
  select
    'coverage'::text            as category,
    'price_daily_symbols'::text as key,
    '收盤價涵蓋檔數'::text       as label,
    case
      when median_n is null or median_n = 0        then 'ok'
      when latest_n < median_n * 0.6               then 'danger'
      when latest_n < median_n * 0.8               then 'warn'
      else 'ok'
    end::text                   as level,
    latest_n                    as metric_num,
    (latest_n::int || ' 檔(近 20 日中位 ' || median_n::int || ')')::text as metric_text,
    case
      when median_n > 0 and latest_n < median_n * 0.8
        then '最新交易日檔數低於近期中位 20% 以上,可能有整個市場別漏收(tpex/twse)'
      else null
    end::text                   as detail,
    null::timestamptz           as last_at,
    2                           as sort_group
  from cov_stat
),
quota_rows as (
  select
    'quota'::text as category,
    q.source      as key,
    case q.source
      when 'finmind'   then 'FinMind 主 token(本小時)'
      when 'finmind_2' then 'FinMind 備援 token(本小時)'
      else q.source
    end::text     as label,
    case
      when q.budget > 0 and q.used::numeric / q.budget >= 0.95 then 'danger'
      when q.budget > 0 and q.used::numeric / q.budget >= 0.75 then 'warn'
      else 'ok'
    end::text     as level,
    case when q.budget > 0
      then round(100.0 * q.used / q.budget, 1)
      else null
    end::numeric  as metric_num,
    (q.used || ' / ' || q.budget)::text as metric_text,
    case
      when q.budget > 0 and q.used::numeric / q.budget >= 0.75
        then 'FinMind 上限為 600/小時(無日上限),本小時已用掉大半;整點會歸零'
      else null
    end::text     as detail,
    null::timestamptz as last_at,
    3             as sort_group
  from public.api_quota_state q
  where q.quota_date = current_date
)
select * from src_rows
union all
select * from fresh_rows
union all
select * from coverage_rows
union all
select * from quota_rows;

grant select on public.v_data_health to service_role;
