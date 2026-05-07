-- 收盤主表(主力 lock + provisional fill)+ 即時報價快取

create table public.price_daily (
  symbol text not null,
  trade_date date not null,
  open numeric(12,4),
  high numeric(12,4),
  low numeric(12,4),
  close numeric(12,4) not null,
  volume bigint,
  source text not null,
  is_provisional boolean not null default false,
  fetched_at timestamptz not null default now(),
  primary key (symbol, trade_date)
);
create index idx_price_daily_date on public.price_daily (trade_date desc);
create index idx_price_daily_provisional
  on public.price_daily (symbol, trade_date)
  where is_provisional = true;

create table public.price_intraday_cache (
  symbol text not null,
  quoted_at timestamptz not null,
  price numeric(12,4) not null,
  volume bigint,
  source text not null,
  primary key (symbol, quoted_at)
);
create index idx_price_intraday_recent on public.price_intraday_cache (quoted_at desc);
