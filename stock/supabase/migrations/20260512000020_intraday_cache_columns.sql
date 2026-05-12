-- M8.3:price_intraday_cache 補欄位給 fetch-yahoo-intraday 用
--
-- 現況(M1 建的):symbol / quoted_at / price / volume / source / PK(symbol, quoted_at)
-- 補:change_pct / market_state / currency / updated_at
--
-- 注意:這張表是「即時快取」,不是 first-write-wins 的 price_daily,
--      EF 寫入用 ON CONFLICT (symbol, quoted_at) DO UPDATE(L11 例外)

alter table public.price_intraday_cache
  add column if not exists change_pct numeric(10,4);

alter table public.price_intraday_cache
  add column if not exists market_state text;
  -- Yahoo Finance 值:REGULAR / CLOSED / PRE / POST / PREPRE / POSTPOST

alter table public.price_intraday_cache
  add column if not exists currency text;

alter table public.price_intraday_cache
  add column if not exists updated_at timestamptz not null default now();

-- 新索引:取 latest-per-symbol(用於 v_latest_price_realtime 的 distinct on)
-- 既有 idx_price_intraday_recent(quoted_at desc)+ 這個一起組合得宜
create index if not exists idx_price_intraday_symbol_quoted
  on public.price_intraday_cache (symbol, quoted_at desc);
