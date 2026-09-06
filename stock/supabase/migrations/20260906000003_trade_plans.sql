create table public.trade_plans (
  id uuid primary key default gen_random_uuid(),
  symbol text not null check (symbol ~ '^[0-9A-Za-z]{4,6}$'),
  strategy_version text not null,
  signal_date date not null,
  signal_snapshot jsonb not null,
  entry_min numeric(12,4) not null check (entry_min > 0),
  entry_max numeric(12,4) not null check (entry_max >= entry_min),
  stop_price numeric(12,4) not null check (stop_price > 0 and stop_price < entry_min),
  valid_until date not null check (valid_until >= signal_date),
  entry_reason text not null check (length(entry_reason) between 5 and 1000),
  exit_rule text not null check (length(exit_rule) between 5 and 1000),
  status text not null default 'watching' check (status in ('watching', 'entered', 'cancelled')),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);
alter table public.trade_plans enable row level security;
revoke all on public.trade_plans from anon, authenticated;
grant select, insert, update on public.trade_plans to service_role;
create index trade_plans_active on public.trade_plans(created_at desc) where status = 'watching';

alter table public.holdings_transactions add column plan_id uuid references public.trade_plans(id);

-- Snapshot is read by the server, never accepted as a client-supplied score.
create or replace function public.create_breakout_plan(
  p_symbol text, p_signal_date date, p_entry_min numeric, p_entry_max numeric,
  p_stop_price numeric, p_valid_until date, p_entry_reason text, p_exit_rule text
) returns uuid language plpgsql security definer set search_path = public as $$
declare s public.v_breakout_scan%rowtype; plan_id uuid; today date; coverage_n numeric; usual_n numeric;
begin
  today := (now() at time zone 'Asia/Taipei')::date;
  select * into s from public.v_breakout_scan where symbol = p_symbol;
  if not found or p_signal_date is null or s.trade_date <> p_signal_date or s.score_total < 80 then
    raise exception '候選已更新，請重新整理掃描頁';
  end if;
  if s.trade_date > today or s.trade_date < today - 7 or p_valid_until < today or p_valid_until > today + 30 then
    raise exception '資料或計畫期限不適用，請確認日期';
  end if;
  select count(*) into coverage_n from public.price_daily where trade_date = s.trade_date;
  select percentile_cont(0.5) within group (order by n) into usual_n from (
    select count(*) as n from public.price_daily where trade_date < s.trade_date
    group by trade_date order by trade_date desc limit 20
  ) recent;
  if usual_n is null or coverage_n < usual_n * 0.8 then
    raise exception '當日價格涵蓋不足，請先檢查資料健康';
  end if;
  insert into public.trade_plans(symbol, strategy_version, signal_date, signal_snapshot,
    entry_min, entry_max, stop_price, valid_until, entry_reason, exit_rule)
  values (p_symbol, 'breakout-v3-adjusted', s.trade_date,
    to_jsonb(s) || jsonb_build_object('coverage_n',coverage_n,'usual_n',usual_n,'captured_at',now()),
    p_entry_min, p_entry_max, p_stop_price, p_valid_until, p_entry_reason, p_exit_rule)
  returning id into plan_id;
  return plan_id;
end $$;
revoke all on function public.create_breakout_plan(text,date,numeric,numeric,numeric,date,text,text) from public, anon, authenticated;
grant execute on function public.create_breakout_plan(text,date,numeric,numeric,numeric,date,text,text) to service_role;

-- Atomically link an actual BUY to its original plan. Recording an off-plan fill is
-- allowed (including after expiry); preserve it for review rather than hiding it.
create or replace function public.record_plan_buy(p_plan_id uuid, p_qty integer,
  p_price numeric, p_fee numeric, p_txn_date date, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare p public.trade_plans%rowtype;
begin
  select * into p from public.trade_plans where id = p_plan_id for update;
  if not found or p.status <> 'watching' then raise exception '計畫已記錄或已取消'; end if;
  if p_qty is null or p_price is null or p_fee is null or p_txn_date is null
    or p_qty <= 0 or p_price <= 0 or p_fee < 0 or p_txn_date < p.signal_date
    or p_txn_date > (now() at time zone 'Asia/Taipei')::date then
    raise exception '成交資料不正確';
  end if;
  insert into public.holdings_transactions(symbol,txn_type,qty,price,fee,tax,txn_date,note,
    signal_source,signal_score,plan_id)
  values(p.symbol,'BUY',p_qty,p_price,p_fee,0,p_txn_date,p_note,
    'scan',(p.signal_snapshot->>'score_total')::numeric,p.id);
  update public.trade_plans set status = 'entered' where id = p.id;
end $$;
revoke all on function public.record_plan_buy(uuid,integer,numeric,numeric,date,text) from public, anon, authenticated;
grant execute on function public.record_plan_buy(uuid,integer,numeric,numeric,date,text) to service_role;
