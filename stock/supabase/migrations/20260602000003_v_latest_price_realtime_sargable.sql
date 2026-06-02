-- 效能優化 B:消掉 v_latest_price_realtime 的兩個全表掃描
--
-- 背景(優化 A 已做掉 intraday cache 累積後,EXPLAIN ANALYZE 量出剩餘瓶頸):
--   v_holdings_full(dashboard 每次 render)join v_latest_price_realtime,後者兩個 seq scan:
--   1) intraday_latest:filter `quoted_at::date = current_date` 是 expression
--      → planner 放棄 idx_price_intraday_symbol_quoted(symbol, quoted_at desc)→ seq scan price_intraday_cache
--   2) daily_recent:`trade_date < current_date` 無時間下界
--      → 掃 price_daily 全歷史 ~12.7 萬列(剩餘主瓶頸 ~1.85s)
--
-- 本 migration 只改「取數範圍」,不改任何輸出語義(output column / 表達式 / join / coalesce 全不動):
--
--   改寫 1(intraday,時區安全):
--     `quoted_at::date = current_date`
--     → `quoted_at >= current_date::timestamptz and quoted_at < (current_date + 1)::timestamptz`
--     等價性:`col::date = current_date` ⟺ `col >= current_date::timestamptz AND col < (current_date+1)::timestamptz`。
--     兩側 `::timestamptz` 與原 `::date` 在同一 session TimeZone 下求值,故「任意 session TZ 下 byte-exact 等價」,
--     且不硬編碼任何固定偏移(讓 current_date::timestamptz 跟著 session TZ 走,與原 ::date 同一 TZ)。
--     sargable 範圍比較 → 走 idx_price_intraday_symbol_quoted(symbol, quoted_at desc)。
--
--   改寫 2(daily_recent,加時間下界):
--     `trade_date < current_date`
--     → `trade_date < current_date and trade_date >= current_date - interval '30 days'`
--     等價性:distinct on (symbol) order by ... desc 只取「每檔最近一筆收盤」,只需近 30 天窗即可覆蓋。
--     實證(2026-06-02,service_role 掃 price_daily 近 95 天):156 檔 universe 無一檔「最近收盤(< today)」超過 30 天
--     → 30 天下界對當前資料零語義漂移(每檔都在近 30 天內取得到它的最新收盤;30 天為保險窗)。
--     planner 用 trade_date 範圍把掃描從 ~12.7 萬列縮到近 30 天數千列。
--
-- create or replace 因為 output column / 順序 / 型別完全不變,downstream view(v_holdings_pnl /
-- v_holdings_full / v_holdings_summary / v_industry_quotes / v_etf_picks / v_rank_with_cost …)不需 cascade rebuild。
--
-- 退版驗證(apply 後跑 supabase/migrations/_verify_20260602000003.sql,非 migration 一部分):
--   雙向 EXCEPT diff(新 view vs 舊版同義查詢)兩邊必須 0 row;再 EXPLAIN v_holdings_full 量 ms。

create or replace view public.v_latest_price_realtime as
with intraday_latest as (
  select distinct on (symbol) symbol, price, quoted_at, market_state, source
  from public.price_intraday_cache
  where quoted_at >= current_date::timestamptz
    and quoted_at <  (current_date + 1)::timestamptz
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
    and trade_date >= current_date - interval '30 days'
  order by symbol, trade_date desc
),
all_symbols as (
  select symbol from intraday_latest union select symbol from daily_recent
)
select
  s.symbol,
  coalesce(i.price, dt.close, dr.close)::numeric(12,4) as current_price,
  case
    when i.price is not null then i.quoted_at
    when dt.close is not null then dt.trade_date::timestamptz
    when dr.close is not null then dr.trade_date::timestamptz
  end as as_of_ts,
  case
    when i.price is not null then null::date
    when dt.close is not null then dt.trade_date
    when dr.close is not null then dr.trade_date
  end as trade_date,
  case
    when i.price is not null then i.source
    when dt.close is not null then 'twse_today'
    when dr.close is not null then 'twse_yesterday'
  end as source,
  case
    when i.price is not null then false
    when dt.close is not null then dt.is_provisional
    when dr.close is not null then dr.is_provisional
  end as is_provisional,
  i.market_state
from all_symbols s
left join intraday_latest i on i.symbol = s.symbol
left join daily_today dt on dt.symbol = s.symbol
left join daily_recent dr on dr.symbol = s.symbol;
