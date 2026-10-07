-- Fubon Trade API phase 1b: bank balance, settlement and realized P&L snapshots.
--
-- The broker-sync worker (Railway cron) already writes inventory snapshots. It now also
-- reads accounting.bankRemain / querySettlement / realizedGainsAndLoses and stores them
-- here. Read-only: nothing writes holdings_transactions.
--
-- Access: service_role only (same reason as broker_inventory_snapshot: views and
-- default grants would expose account data through the public anon key).
--
-- Rollback:
--   drop function public.replace_broker_realized(date, jsonb);
--   drop table public.broker_realized_snapshot;
--   drop table public.broker_settlement;
--   drop table public.broker_bank_balance;

-- Bank balance per snapshot day. Only supported for Taipei Fubon Bank / LINE Bank
-- settlement accounts; the worker treats other banks as a soft failure.
create table public.broker_bank_balance (
  snapshot_date date not null,
  account_no text not null,                 -- '<branchNo>-<account>'
  currency text not null,
  balance numeric(16,2) not null,
  available_balance numeric(16,2),
  raw jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (snapshot_date, account_no, currency)
);

-- querySettlement(range '3d'): one row per query day. Days without trades come back
-- with empty amounts, so the amount columns are nullable and settlement_date may be null.
create table public.broker_settlement (
  snapshot_date date not null,
  account_no text not null,
  query_date date not null,
  settlement_date date,
  buy_value numeric(16,2),
  buy_fee numeric(16,2),
  buy_tax numeric(16,2),
  buy_settlement numeric(16,2),
  sell_value numeric(16,2),
  sell_fee numeric(16,2),
  sell_tax numeric(16,2),
  sell_settlement numeric(16,2),
  total_bs_value numeric(16,2),
  total_fee numeric(16,2),
  total_tax numeric(16,2),
  total_settlement_amount numeric(16,2),
  currency text,
  raw jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (snapshot_date, account_no, query_date)
);

-- realizedGainsAndLoses has no date argument and no unique key per row, so a whole day's
-- snapshot is replaced at once (replace_broker_realized), like replace_broker_snapshot.
create table public.broker_realized_snapshot (
  id bigint generated always as identity primary key,
  snapshot_date date not null,
  account_no text not null,
  data_date date,                           -- Realized.date, "data date" in the vendor docs
  symbol text not null check (symbol ~ '^[0-9A-Za-z]{4,6}$'),
  buy_sell text not null,                   -- SDK BsAction as returned: Buy / Sell
  order_type text not null,                 -- SDK OrderType as returned: Stock / Margin / Short / SBL / DayTrade
  filled_qty integer not null,
  filled_price numeric(12,4) not null,
  realized_profit numeric(16,2) not null default 0,
  realized_loss numeric(16,2) not null default 0,
  raw jsonb not null,
  fetched_at timestamptz not null default now()
);
create index broker_realized_snapshot_day_idx
  on public.broker_realized_snapshot (snapshot_date, account_no);

alter table public.broker_bank_balance enable row level security;
alter table public.broker_settlement enable row level security;
alter table public.broker_realized_snapshot enable row level security;
revoke all on public.broker_bank_balance from anon, authenticated;
revoke all on public.broker_settlement from anon, authenticated;
revoke all on public.broker_realized_snapshot from anon, authenticated;
grant select, insert, update, delete on public.broker_bank_balance to service_role;
grant select, insert, update, delete on public.broker_settlement to service_role;
grant select, insert, update, delete on public.broker_realized_snapshot to service_role;

-- Replace a whole day's realized snapshot in one transaction (re-runs on the same day are
-- safe; an empty array clears the day).
create or replace function public.replace_broker_realized(p_date date, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if p_date is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid broker realized payload';
  end if;

  delete from public.broker_realized_snapshot where snapshot_date = p_date;

  insert into public.broker_realized_snapshot (
    snapshot_date, account_no, data_date, symbol, buy_sell, order_type,
    filled_qty, filled_price, realized_profit, realized_loss, raw
  )
  select p_date, r.account_no, r.data_date, r.symbol, r.buy_sell, r.order_type,
         r.filled_qty, r.filled_price, coalesce(r.realized_profit, 0), coalesce(r.realized_loss, 0), r.raw
  from jsonb_to_recordset(p_rows) as r(
    account_no text, data_date date, symbol text, buy_sell text, order_type text,
    filled_qty integer, filled_price numeric, realized_profit numeric, realized_loss numeric,
    raw jsonb
  );
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.replace_broker_realized(date, jsonb) from public, anon, authenticated;
grant execute on function public.replace_broker_realized(date, jsonb) to service_role;
