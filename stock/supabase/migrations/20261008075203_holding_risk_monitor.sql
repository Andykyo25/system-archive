create table public.holding_risk_state(
  symbol text primary key,price_level text not null default 'ok',weight_level text not null default 'ok',
  financial_period date,checked_at timestamptz not null default now()
);
create table public.holding_risk_events(
  id bigint generated always as identity primary key,symbol text not null,kind text not null,
  reason text not null,snapshot jsonb not null,created_at timestamptz not null default now(),
  notified boolean not null default false,delivery_token uuid,delivery_after timestamptz not null default now(),
  delivery_attempts integer not null default 0,delivery_error text
);
alter table public.holding_risk_state enable row level security;
alter table public.holding_risk_events enable row level security;
revoke all on public.holding_risk_state,public.holding_risk_events from public,anon,authenticated;
grant select on public.holding_risk_state,public.holding_risk_events to service_role;
create index holding_risk_pending on public.holding_risk_events(delivery_after) where not notified;
create function public.evaluate_holding_risks(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path=public as $$
declare r record;s public.holding_risk_state;n int:=0;l timestamp:=p_now at time zone 'Asia/Taipei';
  valid_price boolean;all_valid boolean;total numeric;price_level text;weight_level text;distance numeric;weight numeric;
begin
  if extract(isodow from l)>5 or l::time not between time '09:00' and time '13:35' then return 0;end if;
  -- A transaction lock protects state transitions against overlapping workers.
  if not pg_try_advisory_xact_lock(810081) then return 0;end if;
  select coalesce(bool_and(current_price>0 and price_source='twse_mis' and market_state='REGULAR'
    and as_of_ts between p_now-interval '5 minutes' and p_now),false),sum(net_qty*current_price)
    into all_valid,total from public.v_holdings_advice;
  for r in select h.*,f.period_end,f.eps,f.ocf from public.v_holdings_advice h
    left join lateral(select period_end,eps,ocf from public.stock_fundamentals_quarterly f
      where f.symbol=h.symbol and f.period_end<=l::date and f.period_end>=l::date-200
      order by period_end desc limit 1) f on true
  loop
    select * into s from holding_risk_state where symbol=r.symbol;
    valid_price:=coalesce(r.current_price>0 and r.price_source='twse_mis' and r.market_state='REGULAR'
      and r.as_of_ts between p_now-interval '5 minutes' and p_now,false);
    price_level:=coalesce(s.price_level,'ok');weight_level:=coalesce(s.weight_level,'ok');
    if valid_price and r.stop_loss_price>0 then
      distance:=100*(r.current_price/r.stop_loss_price-1);
      if distance<=0 then price_level:='stop';
      elsif distance<=3 and price_level<>'stop' then price_level:='near_stop';
      elsif distance>5 then price_level:='ok';
      elsif distance>3 and price_level='stop' then price_level:='near_stop';end if;
      if price_level<>coalesce(s.price_level,'ok') then
        insert into holding_risk_events(symbol,kind,reason,snapshot) values(r.symbol,'price',
          case price_level when 'stop' then '已觸及既定停損參考' when 'near_stop' then '距停損不足 3%' else '已離開停損警戒區' end,
          jsonb_build_object('price',r.current_price,'stop',r.stop_loss_price,'distance_pct',distance,'as_of_ts',r.as_of_ts,'source',r.price_source,'state',price_level));n:=n+1;
      end if;
    end if;
    if all_valid and total>0 then
      weight:=100*r.net_qty*r.current_price/total;
      if weight>=40 then weight_level:='concentrated';elsif weight<35 then weight_level:='ok';end if;
      if weight_level<>coalesce(s.weight_level,'ok') then
        insert into holding_risk_events(symbol,kind,reason,snapshot) values(r.symbol,'weight',
          case weight_level when 'concentrated' then '單一持股占股票市值達 40%' else '持股集中度已低於 35%' end,
          jsonb_build_object('weight_pct',weight,'as_of_ts',r.as_of_ts,'state',weight_level,'scope','held_market_value_excludes_cash'));n:=n+1;
      end if;
    end if;
    if s.financial_period is not null and r.period_end>s.financial_period
      and (r.eps<0 or r.ocf<0) and r.symbol!~'^00'
      and not exists(select 1 from public.etf_metadata e where e.symbol=r.symbol) then
      insert into holding_risk_events(symbol,kind,reason,snapshot) values(r.symbol,'financial',
        '新一期季報出現負 EPS 或負營業現金流，請檢視財報',
        jsonb_build_object('period',r.period_end,'eps',r.eps,'ocf',r.ocf,'observed_at',p_now,'publication_time_known',false));n:=n+1;
    end if;
    insert into holding_risk_state(symbol,price_level,weight_level,financial_period,checked_at)
      values(r.symbol,price_level,weight_level,r.period_end,p_now)
    on conflict(symbol) do update set price_level=excluded.price_level,weight_level=excluded.weight_level,
      financial_period=coalesce(excluded.financial_period,holding_risk_state.financial_period),checked_at=p_now;
  end loop;
  return n;
end $$;
revoke all on function public.evaluate_holding_risks(timestamptz) from public,anon,authenticated;
grant execute on function public.evaluate_holding_risks(timestamptz) to service_role;
create function public.claim_holding_risks(p_token uuid)
returns setof public.holding_risk_events language sql security definer set search_path=public as $$
  update public.holding_risk_events e set delivery_token=p_token,delivery_after=now()+interval '10 minutes',delivery_attempts=delivery_attempts+1
  where id in(select id from public.holding_risk_events where not notified and delivery_after<=now() order by id limit 10 for update skip locked)
  returning e.*;
$$;
create function public.finish_holding_risk(p_id bigint,p_token uuid,p_delivered boolean)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  update public.holding_risk_events set notified=p_delivered,
    delivery_error=case when p_delivered then null else 'delivery failed; retry after lease expires' end
  where id=p_id and delivery_token=p_token;
  return found;
end $$;
revoke all on function public.claim_holding_risks(uuid),public.finish_holding_risk(bigint,uuid,boolean) from public,anon,authenticated;
grant execute on function public.claim_holding_risks(uuid),public.finish_holding_risk(bigint,uuid,boolean) to service_role;
