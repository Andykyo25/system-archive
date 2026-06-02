-- 退版驗證腳本(非 migration;apply 20260602000003 後手動執行,逐段跑)
-- 目的:證明改寫「零語義漂移」(byte-exact)+ 量 v_holdings_full 改後 ms。
--
-- 用法:apply migration 後,在 Supabase SQL editor / execute_sql 逐段貼。
-- 「舊版同義查詢」= 20260512000077 原文(quoted_at::date = current_date / trade_date < current_date 無下界),
-- 逐字內聯成 CTE old_view,因為 apply 後線上 view 已是新版,無法 select 舊 view。

-- ───────────────────────────────────────────────────────────────────────────
-- 段 1:雙向 EXCEPT diff(兩段各自必須回 0 row)
-- ───────────────────────────────────────────────────────────────────────────

-- 1a) 新 view 有、舊版沒有的 row(必須 0)
with old_view as (
  with intraday_latest as (
    select distinct on (symbol) symbol, price, quoted_at, market_state, source
    from public.price_intraday_cache
    where quoted_at::date = current_date
    order by symbol, quoted_at desc
  ),
  daily_today as (
    select distinct on (symbol) symbol, close, trade_date, is_provisional, source
    from public.price_daily
    where trade_date = current_date
    order by symbol, trade_date desc
  ),
  daily_recent as (
    select distinct on (symbol) symbol, close, trade_date, is_provisional, source
    from public.price_daily
    where trade_date < current_date
    order by symbol, trade_date desc
  ),
  all_symbols as (
    select symbol from intraday_latest union select symbol from daily_recent
  )
  select
    s.symbol,
    coalesce(i.price, dt.close, dr.close)::numeric(12,4) as current_price,
    case when i.price is not null then i.quoted_at
         when dt.close is not null then dt.trade_date::timestamptz
         when dr.close is not null then dr.trade_date::timestamptz end as as_of_ts,
    case when i.price is not null then null::date
         when dt.close is not null then dt.trade_date
         when dr.close is not null then dr.trade_date end as trade_date,
    case when i.price is not null then i.source
         when dt.close is not null then 'twse_today'
         when dr.close is not null then 'twse_yesterday' end as source,
    case when i.price is not null then false
         when dt.close is not null then dt.is_provisional
         when dr.close is not null then dr.is_provisional end as is_provisional,
    i.market_state
  from all_symbols s
  left join intraday_latest i on i.symbol = s.symbol
  left join daily_today dt on dt.symbol = s.symbol
  left join daily_recent dr on dr.symbol = s.symbol
)
select 'new_minus_old' as direction, * from (
  select * from public.v_latest_price_realtime
  except
  select * from old_view
) d;

-- 1b) 舊版有、新 view 沒有的 row(必須 0)— 把上面 except 兩側對調再跑一次:
with old_view as (
  with intraday_latest as (
    select distinct on (symbol) symbol, price, quoted_at, market_state, source
    from public.price_intraday_cache
    where quoted_at::date = current_date
    order by symbol, quoted_at desc
  ),
  daily_today as (
    select distinct on (symbol) symbol, close, trade_date, is_provisional, source
    from public.price_daily
    where trade_date = current_date
    order by symbol, trade_date desc
  ),
  daily_recent as (
    select distinct on (symbol) symbol, close, trade_date, is_provisional, source
    from public.price_daily
    where trade_date < current_date
    order by symbol, trade_date desc
  ),
  all_symbols as (
    select symbol from intraday_latest union select symbol from daily_recent
  )
  select
    s.symbol,
    coalesce(i.price, dt.close, dr.close)::numeric(12,4) as current_price,
    case when i.price is not null then i.quoted_at
         when dt.close is not null then dt.trade_date::timestamptz
         when dr.close is not null then dr.trade_date::timestamptz end as as_of_ts,
    case when i.price is not null then null::date
         when dt.close is not null then dt.trade_date
         when dr.close is not null then dr.trade_date end as trade_date,
    case when i.price is not null then i.source
         when dt.close is not null then 'twse_today'
         when dr.close is not null then 'twse_yesterday' end as source,
    case when i.price is not null then false
         when dt.close is not null then dt.is_provisional
         when dr.close is not null then dr.is_provisional end as is_provisional,
    i.market_state
  from all_symbols s
  left join intraday_latest i on i.symbol = s.symbol
  left join daily_today dt on dt.symbol = s.symbol
  left join daily_recent dr on dr.symbol = s.symbol
)
select 'old_minus_new' as direction, * from (
  select * from old_view
  except
  select * from public.v_latest_price_realtime
) d;

-- 兩段都回 0 row = byte-exact 零語義漂移。任一段有 row = 改寫破壞語義(查那幾檔 symbol 看是時區邊界還是 30 天窗漏檔)。

-- ───────────────────────────────────────────────────────────────────────────
-- 段 2:量 v_holdings_full 執行時間(對照改前 2374ms)
-- ───────────────────────────────────────────────────────────────────────────
explain (analyze, costs off, timing off) select * from public.v_holdings_full;
-- 看底部 "Execution Time: X ms"。預期 intraday 改走 idx_price_intraday_symbol_quoted、
-- daily_recent 改走 trade_date 範圍(掃近 30 天而非 12.7 萬)→ 目標 < 1000ms。
-- 也可加 buffers 看 shared read 降幅:explain (analyze, buffers) select * from public.v_holdings_full;
