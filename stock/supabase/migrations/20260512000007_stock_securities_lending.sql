-- M8: 借券交易明細(FinMind TaiwanStockSecuritiesLending)
--
-- 這個 dataset 是明細性質,每筆借券一個 row:
--   date, stock_id, transaction_type (議借/競借/標借), volume, fee_rate, close, original_return_date, original_lending_period
--
-- 我們存原始明細,加 daily aggregate view 供分析(每天該股總借券量)
--
-- 借券餘額減少 = 借券人歸還(空單回補),通常股價有壓力測試完
-- 借券餘額暴增 = 預備放空(警示信號)

create table if not exists public.stock_securities_lending (
  id bigserial primary key,
  symbol text not null,
  trade_date date not null,
  transaction_type text,           -- 議借 / 競借 / 標借
  volume numeric(14,0),
  fee_rate numeric(8,4),
  close_price numeric(12,4),
  original_return_date date,
  original_lending_period integer,
  fetched_at timestamptz not null default now()
);
create index if not exists idx_lending_recent on public.stock_securities_lending (trade_date desc);
create index if not exists idx_lending_symbol_recent on public.stock_securities_lending (symbol, trade_date desc);

-- 因為 FinMind 同一 (symbol, date) 會有多筆,沒辦法做 unique PK
-- 改用 idempotency hash:用 (symbol, trade_date, txn_type, volume, fee_rate) 做 deduplication
-- 用 unique constraint 確保 fetcher 重跑不會插重複
create unique index if not exists ux_lending_idempotent
  on public.stock_securities_lending (symbol, trade_date, transaction_type, volume, fee_rate);

alter table public.stock_securities_lending enable row level security;

-- 每日 aggregate view 供分析用(總借券量 = 該日 sum(volume))
create or replace view public.v_securities_lending_daily as
select
  symbol,
  trade_date,
  sum(volume) as daily_lending_volume,
  avg(fee_rate) as avg_fee_rate
from public.stock_securities_lending
group by symbol, trade_date;
