-- 2026-06-09: 彙總 / 權益曲線納入當沖損益(只加當沖、欄位順序型別不動 = append-only)
--
-- v_holdings_summary.total_realized_pnl / total_pnl 加當沖損益(v_day_trades_realized)
-- v_equity_curve.events 加 DAY_TRADE 事件(delta = realized_pnl,賠錢=負 → 曲線下移)
-- 持股移動平均邏輯(v_holdings_realized/current)完全不碰。

create or replace view public.v_holdings_summary as
with txn_agg as (
  select
    symbol,
    sum(case when txn_type = 'BUY'  then qty else 0 end) as buy_qty,
    sum(case when txn_type = 'SELL' then qty else 0 end) as sell_qty,
    sum(case when txn_type = 'BUY'  then qty * price + fee else 0 end) as invested,
    sum(case when txn_type = 'SELL' then qty * price - fee - tax else 0 end) as recovered
  from public.holdings_transactions
  group by symbol
),
realized as (
  select coalesce(sum(realized_pnl), 0) as total_realized_pnl
  from public.v_holdings_realized
),
day_trade as (
  select coalesce(sum(realized_pnl), 0) as total_dt_pnl
  from public.v_day_trades_realized
),
unrealized as (
  select
    coalesce(sum(
      case when lp.current_price is not null
        then (lp.current_price - c.avg_cost) * c.net_qty
      end
    ), 0) as total_unrealized_pnl
  from public.v_holdings_current c
  left join public.v_latest_price_realtime lp on lp.symbol = c.symbol
)
select
  ((select total_realized_pnl from realized) + (select total_dt_pnl from day_trade)) as total_realized_pnl,
  (select total_unrealized_pnl from unrealized) as total_unrealized_pnl,
  ((select total_realized_pnl from realized) + (select total_dt_pnl from day_trade)
    + (select total_unrealized_pnl from unrealized)) as total_pnl,
  coalesce((select sum(invested) from txn_agg), 0) as total_invested,
  coalesce((select sum(recovered) from txn_agg), 0) as total_recovered,
  (select count(*) from public.v_holdings_current) as count_holdings,
  coalesce((
    select count(*) from txn_agg
    where buy_qty > 0 and buy_qty - sell_qty = 0
  ), 0) as count_closed;

create or replace view public.v_equity_curve as
with events as (
  select
    txn_date    as event_date, created_at, symbol, 'BUY' as event_type,
    qty, price,
    -coalesce(fee, 0)::numeric as delta, null::numeric as realized_pnl
  from public.holdings_transactions
  where txn_type = 'BUY'
  union all
  select
    sell_date as event_date, created_at, symbol, 'SELL' as event_type,
    qty_sold as qty, sell_price as price, realized_pnl as delta, realized_pnl
  from public.v_holdings_realized
  union all
  select
    sell_date as event_date, created_at, symbol, 'DAY_TRADE' as event_type,
    qty_sold as qty, sell_price as price, realized_pnl as delta, realized_pnl
  from public.v_day_trades_realized
),
cap as (
  select coalesce(max(value), 0) * 10000 as base
  from public.app_settings
  where key = 'initial_capital'
)
select
  e.event_date,
  e.created_at,
  e.symbol,
  e.event_type,
  e.qty,
  e.price,
  e.delta,
  e.realized_pnl,
  (select base from cap)
    + sum(e.delta) over (
        order by e.event_date, e.created_at
        rows between unbounded preceding and current row
      ) as equity
from events e
order by e.event_date, e.created_at;
