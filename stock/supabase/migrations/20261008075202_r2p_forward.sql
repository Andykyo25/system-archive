create table public.r2p_forward_batches(
  strategy_version text not null, signal_date date not null,
  frozen_at timestamptz not null default now(), evidence jsonb not null,
  primary key(strategy_version,signal_date)
);
create table public.r2p_forward_state(
  strategy_version text primary key, revision integer not null default 0,
  payload jsonb not null, updated_at timestamptz not null default now()
);
create table public.r2p_forward_daily(
  strategy_version text not null, trade_date date not null,
  equity numeric not null, cash numeric not null, max_drawdown numeric not null,
  benchmark_pct numeric, positions integer not null, closed integer not null,
  recorded_at timestamptz not null default now(), primary key(strategy_version,trade_date)
);
alter table public.r2p_forward_batches enable row level security;
alter table public.r2p_forward_state enable row level security;
alter table public.r2p_forward_daily enable row level security;
revoke all on public.r2p_forward_batches,public.r2p_forward_state,public.r2p_forward_daily from public,anon,authenticated;
grant select on public.r2p_forward_batches,public.r2p_forward_state,public.r2p_forward_daily to service_role;

create function public.freeze_r2p_forward()
returns boolean language plpgsql security definer set search_path=public as $$
declare d date; e jsonb; n numeric; typical numeric; local_now timestamp:=now() at time zone 'Asia/Taipei';
begin
  if extract(isodow from local_now)>5 or local_now::time<time '18:00' then return false;end if;
  select max(trade_date) into d from public.price_daily where symbol='0050';
  -- Only prospectively freeze today's completed data. Never reconstruct prior signals.
  if d is distinct from local_now::date then return false;end if;
  select count(*) into n from public.price_daily where trade_date=d;
  select percentile_cont(0.5) within group(order by c) into typical from
    (select count(*) c from public.price_daily where trade_date<d group by trade_date order by trade_date desc limit 20) p;
  if typical is null or n<typical*0.8 then return false;end if;
  if exists(select 1 from r2p_forward_batches where strategy_version='R2p-forward-v1' and signal_date=d) then return false;end if;
  select coalesce(jsonb_agg(x order by (x->>'rank')::int),'[]'::jsonb) into e from (
    select jsonb_build_object('date',d,'symbol',v.symbol,'rank',row_number() over(order by v.score_total desc,v.day_pct desc,v.symbol),
      'stop',v.close-3*v.atr14,'close',v.close,'factor',p.adj_factor,
      'selection',to_jsonb(v),'dimensions',(select to_jsonb(r) from public.v_stock_rank r where r.symbol=v.symbol)) x
    from public.v_scan_verdict v join public.price_daily p on p.symbol=v.symbol and p.trade_date=d
    where v.trade_date=d
  ) s;
  insert into public.r2p_forward_batches values('R2p-forward-v1',d,now(),e) on conflict do nothing;
  return found;
end $$;
revoke all on function public.freeze_r2p_forward() from public,anon,authenticated;
grant execute on function public.freeze_r2p_forward() to service_role;

create function public.commit_r2p_forward(p_revision integer,p_state jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare d date:=(p_state->>'lastDate')::date;n integer;v text:=p_state->>'version';
begin
  if v is distinct from 'R2p-forward-v1' or d is null or (p_state->>'cash')::numeric<0 then raise exception 'invalid ledger';end if;
  if p_revision=-1 then
    insert into r2p_forward_state values(v,0,p_state,now()) on conflict do nothing;
  else
    update r2p_forward_state set revision=revision+1,payload=p_state,updated_at=now()
      where strategy_version=v and revision=p_revision and (payload->>'lastDate')::date<d;
  end if;
  get diagnostics n=row_count;
  if n=0 then return false;end if;
  insert into r2p_forward_daily(strategy_version,trade_date,equity,cash,max_drawdown,benchmark_pct,positions,closed)
    values(v,d,(p_state->>'equity')::numeric,(p_state->>'cash')::numeric,(p_state->>'maxDrawdown')::numeric,
      (p_state->>'benchmark')::numeric,jsonb_array_length(p_state->'positions'),
      (select count(*) from jsonb_array_elements(p_state->'trades') t where t->>'exitDate' is not null));
  return true;
end $$;
revoke all on function public.commit_r2p_forward(integer,jsonb) from public,anon,authenticated;
grant execute on function public.commit_r2p_forward(integer,jsonb) to service_role;
