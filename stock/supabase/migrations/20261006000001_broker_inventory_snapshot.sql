-- Fubon Trade API phase 1: read-only broker inventory snapshot for reconciliation.
--
-- A worker (stock/workers/broker-sync, Railway cron) reads inventories + unrealized
-- gains/losses from the broker API and calls replace_broker_snapshot() once a day.
-- Nothing here writes holdings_transactions; v_broker_recon only compares.
--
-- Access: service_role only. v_broker_recon is revoked from anon/authenticated on
-- purpose -- views are owned by postgres and bypass RLS, so a default grant would
-- expose holdings through the public anon key.
--
-- Rollback:
--   drop view public.v_broker_recon;
--   drop function public.replace_broker_snapshot(date, jsonb);
--   drop table public.broker_inventory_snapshot;
--   drop table public.broker_snapshot_run;

-- One row per snapshot day. Lets "broker holds nothing" be represented (row_count = 0).
create table public.broker_snapshot_run (
  snapshot_date date primary key,
  row_count integer not null check (row_count >= 0),
  fetched_at timestamptz not null default now()
);

create table public.broker_inventory_snapshot (
  snapshot_date date not null references public.broker_snapshot_run(snapshot_date) on delete cascade,
  account_no text not null,                 -- '<branchNo>-<account>'
  symbol text not null check (symbol ~ '^[0-9A-Za-z]{4,6}$'),
  order_type text not null,                 -- SDK OrderType as returned: Stock / Margin / Short / SBL / DayTrade ...
  board_qty integer not null,               -- inventories.todayQty (board lot, shares)
  odd_qty integer not null default 0,       -- inventories.odd.todayQty (odd lot, shares)
  tradable_qty integer,
  cost_price numeric(12,4),                 -- unrealizedGainsAndLoses.costPrice (per share, may include fees)
  unrealized_pnl numeric(14,2),             -- unrealizedProfit - unrealizedLoss
  raw jsonb not null,
  primary key (snapshot_date, account_no, symbol, order_type)
);

alter table public.broker_snapshot_run enable row level security;
alter table public.broker_inventory_snapshot enable row level security;
revoke all on public.broker_snapshot_run from anon, authenticated;
revoke all on public.broker_inventory_snapshot from anon, authenticated;
grant select, insert, update, delete on public.broker_snapshot_run to service_role;
grant select, insert, update, delete on public.broker_inventory_snapshot to service_role;

-- Replace a whole day's snapshot in one transaction (re-runs on the same day are safe).
create or replace function public.replace_broker_snapshot(p_date date, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if p_date is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid broker snapshot payload';
  end if;

  delete from public.broker_snapshot_run where snapshot_date = p_date;  -- cascades to rows
  insert into public.broker_snapshot_run (snapshot_date, row_count)
  values (p_date, jsonb_array_length(p_rows));

  insert into public.broker_inventory_snapshot (
    snapshot_date, account_no, symbol, order_type,
    board_qty, odd_qty, tradable_qty, cost_price, unrealized_pnl, raw
  )
  select p_date, r.account_no, r.symbol, r.order_type,
         r.board_qty, coalesce(r.odd_qty, 0), r.tradable_qty, r.cost_price, r.unrealized_pnl, r.raw
  from jsonb_to_recordset(p_rows) as r(
    account_no text, symbol text, order_type text,
    board_qty integer, odd_qty integer, tradable_qty integer,
    cost_price numeric, unrealized_pnl numeric, raw jsonb
  );
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.replace_broker_snapshot(date, jsonb) from public, anon, authenticated;
grant execute on function public.replace_broker_snapshot(date, jsonb) to service_role;

-- Latest snapshot vs the system's own open positions (v_holdings_current).
--   match              same quantity (cost within 1%)
--   qty_diff           both sides hold it, quantities differ
--   cost_diff          same quantity, average cost differs by more than 1%
--                      (broker cost may include fees; 1% leaves room for that)
--   missing_in_system  broker holds it, holdings_transactions does not
--   missing_at_broker  holdings_transactions says held, broker does not
-- Only Stock / Margin order types are compared (shorts / SBL / day-trade are ignored).
-- broker_qty = board_qty + odd_qty assumes todayQty excludes odd lots (unverified:
-- check against a real odd-lot position and adjust here if it double counts).
create or replace view public.v_broker_recon as
with run as (
  select snapshot_date, fetched_at
  from public.broker_snapshot_run
  order by snapshot_date desc
  limit 1
),
b as (
  select s.symbol,
         sum(s.board_qty + s.odd_qty)::bigint as broker_qty,
         sum(s.cost_price * (s.board_qty + s.odd_qty))
           / nullif(sum(s.board_qty + s.odd_qty) filter (where s.cost_price is not null), 0) as broker_avg_cost,
         sum(s.unrealized_pnl) as broker_unrealized_pnl
  from public.broker_inventory_snapshot s
  join run on run.snapshot_date = s.snapshot_date
  where s.order_type in ('Stock', 'Margin')
  group by s.symbol
  having sum(s.board_qty + s.odd_qty) > 0
),
m as (
  select symbol, net_qty::bigint as system_qty, avg_cost as system_avg_cost
  from public.v_holdings_current
)
select run.snapshot_date,
       run.fetched_at as snapshot_fetched_at,
       coalesce(b.symbol, m.symbol) as symbol,
       m.system_qty,
       b.broker_qty,
       m.system_avg_cost,
       b.broker_avg_cost,
       b.broker_unrealized_pnl,
       case
         when m.symbol is null then 'missing_in_system'
         when b.symbol is null then 'missing_at_broker'
         when m.system_qty <> b.broker_qty then 'qty_diff'
         when m.system_avg_cost > 0 and b.broker_avg_cost is not null
              and abs(b.broker_avg_cost - m.system_avg_cost) / m.system_avg_cost > 0.01 then 'cost_diff'
         else 'match'
       end as status
from b
full join m on m.symbol = b.symbol
cross join run;

revoke all on public.v_broker_recon from anon, authenticated;
grant select on public.v_broker_recon to service_role;
