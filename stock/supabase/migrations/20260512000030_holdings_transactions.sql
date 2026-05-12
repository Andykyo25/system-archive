-- M8.5: 持股 transaction-log
--
-- 把 `holdings` 從「目前持股快照」改成 transaction log
-- 每筆 BUY/SELL 都進 holdings_transactions,目前持股 / 已實現損益 都是 view 算出來
-- 這層 migration 只負責建新表,搬遷與 view 各自在後續 migration

create table public.holdings_transactions (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  txn_type text not null check (txn_type in ('BUY', 'SELL')),
  qty integer not null check (qty > 0),
  price numeric(12,4) not null check (price >= 0),
  fee numeric(10,2) not null default 0 check (fee >= 0),
  tax numeric(10,2) not null default 0 check (tax >= 0),
  txn_date date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);

create index idx_holdings_txn_symbol_date on public.holdings_transactions (symbol, txn_date);
create index idx_holdings_txn_type on public.holdings_transactions (txn_type);

alter table public.holdings_transactions enable row level security;
