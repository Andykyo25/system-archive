-- 持股、watchlist、模擬下單(使用者直接維護的資料)

create table public.holdings (
  id bigserial primary key,
  symbol text not null,
  qty integer not null check (qty >= 0),
  avg_cost numeric(12,4) not null check (avg_cost >= 0),
  opened_at date not null default current_date,
  closed_at date,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_holdings_symbol on public.holdings (symbol);
create index idx_holdings_open on public.holdings (closed_at) where closed_at is null;

create table public.watchlist (
  id bigserial primary key,
  symbol text not null unique,
  added_at timestamptz not null default now(),
  note text
);

create table public.paper_orders (
  id bigserial primary key,
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  qty integer not null check (qty > 0),
  price numeric(12,4) not null check (price >= 0),
  ordered_at timestamptz not null default now(),
  note text
);
create index idx_paper_orders_symbol_time on public.paper_orders (symbol, ordered_at desc);
