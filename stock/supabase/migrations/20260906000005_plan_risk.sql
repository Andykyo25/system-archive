-- Current cash comes from transaction flows, not rounded PnL. Marks all use the
-- same latest market session. A missing held-symbol mark disables sizing.
create or replace view public.v_plan_risk_context as
with cfg as (
  select
    max(value) filter (where key='initial_capital') * 10000 as initial_capital,
    max(value) filter (where key='risk_pct_per_trade') as risk_pct,
    max(value) filter (where key='commission_base_rate') *
      max(value) filter (where key='commission_discount') as fee_rate,
    max(value) filter (where key='sell_tax_stock') as tax_rate
  from public.app_settings
), bounds as (
  select max(trade_date) as price_date from public.price_daily
), positions as (
  select symbol, sum(case when txn_type='BUY' then qty else -qty end) as qty
  from public.holdings_transactions
  where txn_date <= (now() at time zone 'Asia/Taipei')::date
  group by symbol having sum(case when txn_type='BUY' then qty else -qty end) <> 0
), marks as (
  select p.symbol,p.qty,si.industry_category,px.close * p.qty as market_value
  from positions p cross join bounds b
  left join public.price_daily px on px.symbol=p.symbol and px.trade_date=b.price_date and px.close>0
  left join public.stock_industry si on si.symbol=p.symbol
), balance as (
  select cfg.*,
    cfg.initial_capital + coalesce((select sum(case when txn_type='BUY'
      then -qty*price-coalesce(fee,0)
      else qty*price-coalesce(fee,0)-coalesce(tax,0) end)
      from public.holdings_transactions where txn_date <= (now() at time zone 'Asia/Taipei')::date),0)
    + coalesce((select sum(qty*(sell_price-buy_price)-coalesce(buy_fee,0)-coalesce(sell_fee,0)-coalesce(tax,0))
      from public.day_trades where trade_date <= (now() at time zone 'Asia/Taipei')::date),0) as cash
  from cfg
)
select b.cash, b.cash + coalesce((select sum(market_value) from marks),0) as equity,
  b.risk_pct,b.fee_rate,b.tax_rate,d.price_date,
  not exists(select 1 from marks where market_value is null or qty<0 or industry_category is null) as coverage_ok,
  coalesce((select jsonb_agg(jsonb_build_object('symbol',symbol,'industry',industry_category,'market_value',market_value)) from marks),'[]'::jsonb) as positions,
  now() as calculated_at
from balance b cross join bounds d;
revoke all on public.v_plan_risk_context from anon,authenticated;
grant select on public.v_plan_risk_context to service_role;

alter table public.trade_plans add column risk_snapshot jsonb;

-- The server computes risk from a fresh DB read and passes the resulting snapshot.
-- One transaction saves the plan and its estimate; no client-supplied score/risk.
create or replace function public.create_breakout_plan_with_risk(p_inputs jsonb,p_risk_snapshot jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare new_id uuid;
begin
  new_id := public.create_breakout_plan(p_inputs->>'p_symbol',(p_inputs->>'p_signal_date')::date,
    (p_inputs->>'p_entry_min')::numeric,(p_inputs->>'p_entry_max')::numeric,
    (p_inputs->>'p_stop_price')::numeric,(p_inputs->>'p_valid_until')::date,
    p_inputs->>'p_entry_reason',p_inputs->>'p_exit_rule');
  update public.trade_plans set risk_snapshot=p_risk_snapshot where trade_plans.id=new_id;
  return new_id;
end $$;
revoke all on function public.create_breakout_plan_with_risk(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.create_breakout_plan_with_risk(jsonb,jsonb) to service_role;
