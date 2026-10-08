-- Additive queue; no selection threshold or historical signal is changed.
create table public.collection_candidates(
  symbol text primary key, signal_date date not null, captured_at timestamptz not null default now()
);
create table public.collection_status(
  symbol text not null, dataset text not null, source text not null,
  status text not null check(status in ('ok','empty','error','not_applicable')),
  observed_at timestamptz not null default now(), data_date date,
  published_at timestamptz, reason text, primary key(symbol,dataset)
);
alter table public.collection_candidates enable row level security;
alter table public.collection_status enable row level security;
revoke all on public.collection_candidates,public.collection_status from public,anon,authenticated;
grant all on public.collection_candidates,public.collection_status to service_role;
create table public.official_financial_snapshots(
  symbol text not null, dataset text not null, period_label text not null,
  source text not null, payload jsonb not null, observed_at timestamptz not null default now(),
  published_at timestamptz, primary key(symbol,dataset,period_label)
);
alter table public.official_financial_snapshots enable row level security;
revoke all on public.official_financial_snapshots from public,anon,authenticated;
grant all on public.official_financial_snapshots to service_role;
alter table public.stock_fundamentals_quarterly add column source text;
alter table public.stock_fundamentals_quarterly add column published_at timestamptz;
comment on column public.stock_fundamentals_quarterly.published_at is
  'Actual publication time only. Period end and collection time are not publication time; legacy unknown remains null.';

create view public.v_collection_priority as
with targets as (
  select symbol,1 priority from public.v_holdings_current
  union all select symbol,2 from public.collection_candidates where signal_date >= current_date-7
  union all select symbol,3 from public.watchlist
  union all select symbol,4 from public.industry_stocks
  union all select symbol,4 from public.stock_universe
), t as (select symbol,min(priority) priority from targets where symbol is not null group by symbol)
select t.*, exists(select 1 from public.etf_metadata e where e.symbol=t.symbol) or t.symbol ~ '^00' as is_etf
from t;
grant select on public.v_collection_priority to service_role;
revoke all on public.v_collection_priority from public,anon,authenticated;
create or replace view public.v_fetch_universe_stocks as
select symbol from public.v_collection_priority where not is_etf;

create function public.capture_collection_candidates()
returns integer language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  insert into public.collection_candidates(symbol,signal_date)
    select symbol,trade_date from public.v_scan_verdict order by score_total desc,day_pct desc,symbol limit 10
  on conflict(symbol) do update set signal_date=excluded.signal_date,captured_at=now();
  get diagnostics n=row_count;
  return n;
end $$;
revoke all on function public.capture_collection_candidates() from public,anon,authenticated;
grant execute on function public.capture_collection_candidates() to service_role;
-- Existing chip universe inherits the amended stock universe. FinMind keeps its existing hourly gate.
create function public.reserve_collection_quota(p_n integer)
returns boolean language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  if p_n not between 1 and 120 then raise exception 'invalid quota reservation'; end if;
  insert into public.api_quota_state(source,quota_date,used,budget)
    values('finmind',current_date,0,600) on conflict do nothing;
  update public.api_quota_state set used=used+p_n
    where source='finmind' and quota_date=current_date and used+p_n <= least(budget,540);
  get diagnostics n=row_count;
  return n=1;
end $$;
revoke all on function public.reserve_collection_quota(integer) from public,anon,authenticated;
grant execute on function public.reserve_collection_quota(integer) to service_role;
