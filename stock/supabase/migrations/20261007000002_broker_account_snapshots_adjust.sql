-- Adjusts 20261007000001_broker_account_snapshots.sql before the worker ever wrote to it
-- (all three tables were empty when this ran).
--
--  1. Drop broker_bank_balance: the owner's settlement bank is not Taipei Fubon Bank / LINE
--     Bank, the only banks bankRemain supports, so the worker no longer calls it.
--  2. broker_settlement: key by (account_no, query_date) instead of
--     (snapshot_date, account_no, query_date). querySettlement('3d') returns the last three
--     days on every run, so the old key stored each day up to three times and any sum over
--     the table over-counted. A newer fetch now overwrites the older one.
--  3. replace_broker_realized: replace the whole table, not just one day. The vendor call has
--     no date argument, so the response is "what the broker says now"; a daily copy would
--     duplicate rows and make "latest" ambiguous. snapshot_date keeps the fetch date.
--
-- Rollback:
--   recreate broker_bank_balance exactly as in 20261007000001 (it holds no data worth keeping);
--   alter table public.broker_settlement drop constraint broker_settlement_pkey;
--   alter table public.broker_settlement add primary key (snapshot_date, account_no, query_date);
--   restore replace_broker_realized from 20261007000001 (delete only where snapshot_date = p_date).

drop table public.broker_bank_balance;

alter table public.broker_settlement drop constraint broker_settlement_pkey;
alter table public.broker_settlement add primary key (account_no, query_date);

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

  -- "where id is not null" is every row; it only keeps a mandatory-WHERE guard satisfied.
  delete from public.broker_realized_snapshot where id is not null;

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
