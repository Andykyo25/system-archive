-- 海外/隔夜領先指標管線 — 階段 0 schema(2026-06-02)
--
-- Yahoo v8 chart API 抓 ^SOX / TSM / ^IXIC / NQ=F / ^VIX / UMC。
-- quoted_date = 對應台股盤前交易日(= 美股收盤 timestamp 的台北日期;美股 ~20:00 UTC
-- 收盤 → ~04:00 次日台北 → 該日台股開盤會反映此隔夜 session)。
-- 領先性驗證(階段 1):每個台股交易日 T 配「T 前一夜美股」(天然 point-in-time)。
--
-- EF fetch-overseas-leading 寫此表(upsert on symbol,quoted_date,cache 性質)。
-- service_role 全寫,無 client 寫(對齊既有表,rls_enabled_no_policy 為預期內)。

create table if not exists public.overseas_indicators (
  symbol text not null,
  quoted_date date not null,
  market_time timestamptz,
  last_price numeric(16,4),
  prev_close numeric(16,4),
  change_pct numeric(10,4),
  fetched_at timestamptz not null default now(),
  primary key (symbol, quoted_date)
);
alter table public.overseas_indicators enable row level security;
comment on table public.overseas_indicators is
  'overseas/overnight leading indicators (^SOX/TSM/NQ=F/^VIX via Yahoo v8). quoted_date = the TW trading day this overnight context feeds into pre-open. Lead-lag verification pairs each TW day T with the prior-night US session (point-in-time). Stage 0, 2026-06-02.';
