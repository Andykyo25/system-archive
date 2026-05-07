-- M4 分析層 SQL views
--
-- v_latest_price:每 symbol 最新一筆 close(用 distinct on)
-- v_holdings_pnl:真實持股 + 未實現損益(holdings join 最新價)
-- v_portfolio_summary:portfolio 總計
-- v_paper_positions:模擬部位 net_qty > 0(從 paper_orders aggregate)
-- v_paper_pnl:模擬部位 + 用最新價算的損益

create or replace view public.v_latest_price as
select distinct on (symbol)
  symbol, trade_date, close, source, is_provisional, fetched_at
from public.price_daily
order by symbol, trade_date desc;

create or replace view public.v_holdings_pnl as
select
  h.id,
  h.symbol,
  h.qty,
  h.avg_cost,
  lp.close as current_price,
  lp.trade_date as price_date,
  lp.is_provisional,
  case when lp.close is not null then (lp.close - h.avg_cost) * h.qty end as unrealized_pnl,
  case when lp.close is not null and h.avg_cost > 0
    then ((lp.close - h.avg_cost) / h.avg_cost) * 100
  end as unrealized_pct,
  case when lp.close is not null then h.qty * lp.close end as market_value,
  h.qty * h.avg_cost as cost_basis,
  h.opened_at,
  h.note
from public.holdings h
left join public.v_latest_price lp on lp.symbol = h.symbol
where h.closed_at is null;

create or replace view public.v_portfolio_summary as
select
  count(*) as positions,
  coalesce(sum(cost_basis), 0) as total_cost,
  coalesce(sum(market_value), 0) as total_value,
  coalesce(sum(unrealized_pnl), 0) as total_pnl,
  case when coalesce(sum(cost_basis), 0) > 0
    then sum(unrealized_pnl) / sum(cost_basis) * 100
    else 0
  end as total_pct
from public.v_holdings_pnl
where current_price is not null;

create or replace view public.v_paper_positions as
with agg as (
  select
    symbol,
    sum(case when side = 'buy' then qty else -qty end) as net_qty,
    sum(case when side = 'buy' then qty * price else -qty * price end) as net_invested,
    count(*) as order_count
  from public.paper_orders
  group by symbol
)
select
  symbol,
  net_qty,
  net_invested,
  case when net_qty > 0 then net_invested / net_qty else null end as avg_cost,
  order_count
from agg
where net_qty > 0;

create or replace view public.v_paper_pnl as
select
  pp.symbol,
  pp.net_qty,
  pp.avg_cost,
  lp.close as current_price,
  lp.trade_date as price_date,
  lp.is_provisional,
  case when lp.close is not null then pp.net_qty * lp.close end as market_value,
  pp.net_invested as cost_basis,
  case when lp.close is not null then pp.net_qty * lp.close - pp.net_invested end as unrealized_pnl,
  case when lp.close is not null and pp.net_invested > 0
    then ((pp.net_qty * lp.close - pp.net_invested) / pp.net_invested) * 100
  end as unrealized_pct
from public.v_paper_positions pp
left join public.v_latest_price lp on lp.symbol = pp.symbol;
