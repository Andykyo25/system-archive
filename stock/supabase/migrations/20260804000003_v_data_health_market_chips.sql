-- v_data_health v2:納入 market_chips_daily 新鮮度(M10 Phase 1,2026-08-04)
--
-- 只在 fresh_raw 追加一列,其餘與 20260722000002 完全相同(L37:append-only replace)。
--
-- v_data_health:資料管線健康度單一事實來源
--
-- 動機(2026-07-22):L42/L46/L55 沉默 drift 已重演三次 —— 系統「看起來在跑」
--   (EF 有執行、有寫 fetch_log),實際靜靜停止收料,每次都靠 Andy 肉眼發現。
--   本 view 把「資料是否還在流入」變成可查詢的一等公民,供 /health 頁與 dashboard widget。
--
-- 設計:統一成「檢查項目」長格式(每列 = 一項檢查),前端只讀不自組 SQL。
--   widget 只要 `where level <> 'ok'`,頁面顯示全部。
--
-- 三類 category:
--   source     近 7 天各 EF 執行狀況(fetch_log)
--   freshness  關鍵表最新資料日 vs 最新交易日
--   quota      今日 API 配額用量
--
-- 新鮮度基準用 price_daily 的 max(trade_date) 而非 current_date:
--   自動處理週末/國定假日(盤前 price_daily 本來就還是昨天),不會週一早上整排假警報。
--
-- 門檻寫在 view 內(view 無參數);各表依實際更新頻率給不同天數:
--   日更(收盤/法人/融資/借券/估值/海外)嚴、週更(外資持股)中、月季更(月營收/季報)寬。
create or replace view public.v_data_health as
with ref as (
  -- 最新交易日:price_daily 是最可靠的(TWSE 主力 + FinMind fallback + backfill 三重)
  select coalesce(max(trade_date), current_date) as last_trade_date
  from public.price_daily
),
-- ── A. 資料源健康(近 7 天 fetch_log)────────────────────────────────
src as (
  select
    f.source,
    count(*)                                                        as runs,
    count(*) filter (where f.success)                               as ok_n,
    count(*) filter (where not f.success)                           as fail_n,
    max(f.started_at) filter (where f.success)                      as last_ok_at,
    max(f.started_at)                                               as last_run_at,
    (array_agg(f.success   order by f.started_at desc))[1]          as last_run_ok,
    (array_agg(f.error     order by f.started_at desc)
       filter (where not f.success))[1]                             as last_error
  from public.fetch_log f
  where f.started_at > now() - interval '7 days'
  group by f.source
),
src_rows as (
  select
    'source'::text as category,
    s.source       as key,
    s.source       as label,
    case
      when not s.last_run_ok then 'danger'   -- 最近一次就是失敗 = 現在正壞著
      when s.fail_n > 0      then 'warn'     -- 曾失敗但已恢復 = 間歇
      else 'ok'
    end::text      as level,
    s.fail_n::numeric                                   as metric_num,
    (s.ok_n || '/' || s.runs || ' 成功')::text          as metric_text,
    case
      when s.fail_n > 0 then coalesce(left(s.last_error, 300), '(無錯誤訊息)')
      else null
    end::text      as detail,
    s.last_ok_at   as last_at,
    1              as sort_group
  from src s
),
-- ── B. 資料新鮮度 ────────────────────────────────────────────────
fresh_raw as (
  select 'price_daily'::text                  as tbl, '收盤價'::text        as label,
         max(trade_date)                      as last_date, 2  as warn_d, 4  as danger_d
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
  -- 外資持股:TWSE 每週公布,門檻放寬
  select 'stock_shareholding', '外資持股比', max(report_date), 12, 20
    from public.stock_shareholding
  union all
  -- 月營收:次月 10 日前公布,period 落後 1-2 個月屬正常
  select 'stock_monthly_revenue', '月營收',
         max(make_date(period_year, period_month, 1)), 70, 100
    from public.stock_monthly_revenue
  union all
  -- 季報:財報法定期限 45/90 天,period_end 落後 1 季屬正常
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
-- ── C. 今日 API 配額 ─────────────────────────────────────────────
quota_rows as (
  select
    'quota'::text as category,
    q.source      as key,
    case q.source
      when 'finmind'   then 'FinMind 主 token'
      when 'finmind_2' then 'FinMind 備援 token'
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
        then '配額吃緊,排在後面的 cron 可能 quota_exhausted(L55)'
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
select * from quota_rows;

comment on view public.v_data_health is
  '資料管線健康度檢查清單(source/freshness/quota 三類,level=ok/warn/danger)。'
  '供 /health 頁與 dashboard widget;新鮮度基準為 price_daily 最新交易日以自動排除週末假日。';

grant select on public.v_data_health to service_role;
