-- 期望清單從 view 內的 VALUES 抽成表(2026-08-12)
--
-- 20260811000006 把 v_data_health 的 source 段改成「期望清單 full outer join fetch_log」,
-- 清單寫死在 view 裡的 `expected(source, max_age_days) as (values ...)`。
-- 本輪光是把 margin/lending/institutional/shareholding 搬到 backfill EF(source 改名),
-- 就被迫整段 view 重寫三次 —— 清單是**會動的設定**,不該跟查詢邏輯綁在同一個 DDL 裡。
--
-- 改成表之後:新增/移除/改門檻都是一行 DML,不必碰 view;而且清單本身可查、
-- 可以在 /health 上直接看到「我們期望哪些資料源在跑」。
--
-- rollback:把 view 的 expected CTE 改回 20260811000006 的 VALUES 版本,drop 本表。

create table if not exists public.data_source_expectation (
  source        text primary key,
  max_age_days  int  not null check (max_age_days > 0),
  note          text
);

comment on table public.data_source_expectation is
  'v_data_health 的資料源期望清單:列在這裡的 source 若超過 max_age_days 沒有成功紀錄就報 danger。'
  '這是「壞掉」與「不存在」得以區分的唯一依據 —— 沒有這張表,安靜停擺的資料源只會從監控上消失。';

-- 平日源 4 天(吸收週末:週五跑完到週一早上約 2.7 天,不能誤報);
-- 週更源 10 天;6 小時源 2 天;每日補洞 3 天。
insert into public.data_source_expectation (source, max_age_days, note) values
  ('twse',                       4, 'TWSE 當日收盤(fetch-daily-prices)'),
  ('tpex',                       4, 'TPEx 當日收盤(fetch-daily-prices)'),
  ('finmind',                    4, 'FinMind 收盤 fallback(補當日缺口)'),
  ('finmind_valuation',          4, '本益比/淨值比'),
  ('backfill_institutional',     4, '法人買賣超(2026-08-12 起改走 backfill EF)'),
  ('backfill_margin',            4, '融資融券(2026-08-12 起改走 backfill EF)'),
  ('backfill_lending',           4, '借券(2026-08-12 起改走 backfill EF,4 批)'),
  ('finmind_fundamentals',      10, '季報'),
  ('finmind_monthly_revenue',   10, '月營收'),
  ('backfill_shareholding',     10, '外資持股(2026-08-12 起改走 backfill EF,3 批)'),
  ('backfill_corporate_action', 10, '除權息(還原權值來源,3 批)'),
  ('backfill_price',             4, '持股盤前補洞(L46 防護層)'),
  ('backfill_market_history',    3, '全市場歷史補洞'),
  ('market_chips',               4, '大盤籌碼'),
  ('overseas_leading',           4, '海外領先指標'),
  ('twse_mis_intraday',          4, '盤中即時報價'),
  ('google_news',                2, '個股新聞(4 批)')
on conflict (source) do update
  set max_age_days = excluded.max_age_days,
      note         = excluded.note;

grant select on public.data_source_expectation to service_role;

-- view 只改 expected 這一段:values → 讀表。其餘與 20260811000006 完全相同。
create or replace view public.v_data_health as
with ref as (
  select coalesce(max(trade_date), current_date) as last_trade_date
  from public.price_daily
),
expected as (
  select source, max_age_days from public.data_source_expectation
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
