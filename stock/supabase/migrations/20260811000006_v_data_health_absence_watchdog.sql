-- v_data_health:加「資料源缺席偵測」+ quota 改時配額語意(2026-08-11)
--
-- 動機:8/11 診斷發現 finmind_institutional(最後 8/05)與 finmind_lending(最後 8/06)
--   在 /health 上**不是變紅,是整列不見**。原因是那幾支 EF 的 quota gate 寫在
--   `fetch_log` insert **之前**:
--       if (usedSoFar >= budget) return Response.json({ skipped: "quota_exhausted" });
--       const { data: logRow } = await supabase.from("fetch_log").insert(...)
--   → 沒 fetch_log 就沒 src 那列。而 src 是 `from fetch_log group by source`,
--     沒有列的東西不會出現,於是「壞掉」長得跟「不存在」一模一樣。
--   這是 L42/L46/L55/L60 沉默 drift 的同一個家族,只是這次躲在監控自己的盲區裡。
--
-- 修法:src 從「fetch_log 有什麼就報什麼」改成「期望清單 full outer join fetch_log」。
--   期望清單列出所有應該定期執行的 source 與可容忍的最久沒成功天數;
--   超過就 danger,即使它一列 log 都沒寫。
--   → 不必改任何 EF,而且擋得比改 EF 更廣:cron 被停用、EF 500、pg_net 沒送出、
--     quota gate early return…… 任何原因造成的「安靜停擺」都會被抓到。
--
--   last_ok 用 60 天窗另算(src 的 7 天窗對週更源不夠看:週報源 8 天前跑成功是正常的,
--   但它在 7 天窗內是空的)。
--
-- 併入本檔的第二件事:20260811000004 把 api_quota_state 由日配額改成時配額
--   (FinMind 真實限制是 600/hour、無日上限),quota 那項的標籤與 detail 同步改口徑,
--   否則 /health 上會寫「今日 586/600」但其實是「本小時」。
--
-- 其餘(freshness / coverage / 欄位順序 / 型別)與 20260806000005 完全相同。
-- rollback:重跑 20260722000002 + 20260804000003 + 20260806000005 三檔。

create or replace view public.v_data_health as
with ref as (
  select coalesce(max(trade_date), current_date) as last_trade_date
  from public.price_daily
),
-- ── A. 資料源健康 ────────────────────────────────────────────────
-- A0. 期望清單:每個「應該定期跑」的 source 與可容忍的最久沒成功天數。
--     平日源給 4 天(吸收週末:週五跑完到週一早上約 2.7 天,不能誤報);
--     週更源給 10 天;6 小時源給 2 天。
expected(source, max_age_days) as (
  values
    ('twse',                      4),
    ('tpex',                      4),
    ('finmind',                   4),
    ('finmind_valuation',         4),
    ('finmind_institutional',     4),
    ('finmind_margin',            4),
    ('finmind_lending',           4),
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
-- A1. 最後一次成功(60 天窗):週更源的判斷基準,7 天窗看不到
lastok as (
  select f.source, max(f.started_at) filter (where f.success) as last_ok_at
  from public.fetch_log f
  where f.started_at > now() - interval '60 days'
  group by f.source
),
-- A2. 近 7 天執行統計(顯示用,語意與原版相同)
src as (
  select
    f.source,
    count(*)                                                        as runs,
    count(*) filter (where f.success)                               as ok_n,
    count(*) filter (where not f.success)                           as fail_n,
    -- success is null = 開了 fetch_log 卻沒回來收尾(EF 被 wall-clock 砍掉 / crash)。
    -- 原版的 fail_n 用 `not success`,null 兩邊都不算 → 這種「跑到一半死掉」完全隱形。
    -- google_news 近 7 天 28 次有 20 次是這樣,之前在 /health 上是綠的。
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
    -- 距離最後一次成功幾天(沒有任何成功 → null)
    case when l.last_ok_at is not null
      then floor(extract(epoch from (now() - l.last_ok_at)) / 86400)::int
    end                                                             as stale_days,
    -- 期望清單內、且超過容忍天數(含從未成功)
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
      when j.absent                        then 'danger'  -- 安靜停擺:超過容忍天數沒有成功紀錄
      when j.runs is null                  then 'ok'      -- 期望內但這 7 天沒跑,且 last_ok 還在容忍期(週更源正常)
      when not coalesce(j.last_done_ok, true) then 'danger' -- 最近一次「有收尾」的執行是失敗 = 現在正壞著
      when j.fail_n > 0 or j.stuck_n > 0   then 'warn'    -- 間歇失敗,或跑到一半死掉
      else 'ok'
    end::text      as level,
    (coalesce(j.fail_n, 0) + coalesce(j.stuck_n, 0))::numeric       as metric_num,
    case
      -- 停擺時顯示「多久沒成功」比「近 7 天 N/N」有用得多 ——
      -- institutional 曾同時是「2/2 成功」與「已 5 天沒成功」,兩個都對但擺一起看不懂
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
-- ── B. 資料新鮮度 ────────────────────────────────────────────────
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
-- ── B2. 收盤價涵蓋檔數(整個市場別漏收的偵測)────────────────────
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
-- ── C. API 配額(20260811000004 後為「本小時」用量,非今日累計)──────
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

comment on view public.v_data_health is
  '資料管線健康度檢查清單(source/freshness/coverage/quota 四類,level=ok/warn/danger)。'
  'source 為「期望清單 full outer join fetch_log」,超過容忍天數沒有成功紀錄即 danger,'
  '所以安靜停擺的資料源會變紅而不是從列表消失。quota 為本小時用量(FinMind 600/hour)。';

grant select on public.v_data_health to service_role;
