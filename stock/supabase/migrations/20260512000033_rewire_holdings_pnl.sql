-- M8.5: 改 v_holdings_pnl 吃 v_holdings_current(transaction-log 計算的目前持股)
-- 連動 cascade 重建 v_holdings_full + v_portfolio_summary
--
-- 變更:
-- 1. 來源從 public.holdings 改成 public.v_holdings_current
-- 2. id 改用 symbol(原 holdings.id 是 bigserial,現在沒了)— UI 改用 symbol 當 key
-- 3. opened_at 改成「最早一筆 BUY 的 txn_date」
-- 4. note 改成「最新一筆 BUY/SELL 的 note(取最新交易上的備註,純展示用)」
-- 5. closed_at 條件移除(v_holdings_current 已 filter net_qty > 0)
-- 6. (M8.3 同步)現價來源從 v_latest_price 改 v_latest_price_realtime,
--    surface as_of_ts / price_source / market_state — 跟 M8.3 23 號 migration 對齊。
--    必須在 M8.3 23 號之後 apply(編號自然 33>23 保證)。

drop view if exists public.v_portfolio_summary cascade;
drop view if exists public.v_holdings_full cascade;
drop view if exists public.v_holdings_pnl cascade;

create view public.v_holdings_pnl as
with first_buy as (
  select symbol, min(txn_date) as opened_at
  from public.holdings_transactions
  where txn_type = 'BUY'
  group by symbol
),
latest_note as (
  select distinct on (symbol) symbol, note
  from public.holdings_transactions
  where note is not null and note <> ''
  order by symbol, txn_date desc, created_at desc
)
select
  c.symbol,
  c.net_qty as qty,
  c.avg_cost,
  lp.current_price,
  lp.trade_date as price_date,
  lp.is_provisional,
  lp.as_of_ts,
  lp.source as price_source,
  lp.market_state,
  case when lp.current_price is not null then (lp.current_price - c.avg_cost) * c.net_qty end as unrealized_pnl,
  case when lp.current_price is not null and c.avg_cost > 0
    then ((lp.current_price - c.avg_cost) / c.avg_cost) * 100
  end as unrealized_pct,
  case when lp.current_price is not null then c.net_qty * lp.current_price end as market_value,
  c.total_cost as cost_basis,
  fb.opened_at,
  ln.note
from public.v_holdings_current c
left join public.v_latest_price_realtime lp on lp.symbol = c.symbol
left join first_buy fb on fb.symbol = c.symbol
left join latest_note ln on ln.symbol = c.symbol;

-- v_holdings_full:同 migration 22 結構,但 base 是新 v_holdings_pnl(沒有 id)
-- 改用 symbol 當 key
create view public.v_holdings_full as
with settings as (
  select
    (select value from public.app_settings where key = 'commission_discount') *
      (select value from public.app_settings where key = 'commission_base_rate') as fee_rate,
    (select value from public.app_settings where key = 'sell_tax_stock') as tax_stock,
    (select value from public.app_settings where key = 'sell_tax_etf') as tax_etf
),
stock_primary_industry as (
  select distinct on (symbol) symbol, industry
  from public.industry_stocks
  order by symbol, display_order
),
holdings_with_type as (
  select
    h.*,
    case when h.symbol ~ '^00\d+' then 'etf' else 'stock' end as stock_type,
    case when h.symbol ~ '^00\d+' then s.tax_etf else s.tax_stock end as sell_tax_rate,
    s.fee_rate as commission_rate
  from public.v_holdings_pnl h
  cross join settings s
)
select
  h.symbol, h.qty, h.avg_cost, h.current_price, h.price_date, h.is_provisional,
  h.as_of_ts, h.price_source, h.market_state,
  h.unrealized_pnl, h.unrealized_pct, h.market_value, h.cost_basis,
  h.opened_at, h.note,
  h.stock_type, h.commission_rate, h.sell_tax_rate,
  h.qty * h.avg_cost * (1 + h.commission_rate) as total_cost_with_fee,
  case when h.current_price is not null then
    h.qty * h.current_price * (1 - h.commission_rate - h.sell_tax_rate)
  end as net_proceeds_if_sold_now,
  case when h.current_price is not null then
    h.qty * h.current_price * (1 - h.commission_rate - h.sell_tax_rate)
    - h.qty * h.avg_cost * (1 + h.commission_rate)
  end as net_pnl_est,
  case when h.current_price is not null and h.qty * h.avg_cost > 0 then
    (h.qty * h.current_price * (1 - h.commission_rate - h.sell_tax_rate)
     - h.qty * h.avg_cost * (1 + h.commission_rate))
    / (h.qty * h.avg_cost * (1 + h.commission_rate)) * 100
  end as net_pct_est,
  spi.industry as primary_industry,
  ss.eps_ttm, ss.eps_yoy_pct, ss.last_q_eps_yoy_pct, ss.forecast_eps_yoy_pct,
  ss.roe_ttm, ss.fcf_ttm, ss.eps_pos_quarters, ss.quarters_available,
  ss.gross_margin_pct, ss.gross_margin_yoy_pp,
  ss.pe, ss.pb, ss.peg, ss.peg_basis, ss.dividend_yield,
  ss.latest_revenue_period, ss.latest_revenue, ss.latest_revenue_yoy_pct,
  coalesce(pt.pb_max, 3.0::numeric(8,2)) as pb_threshold,
  (case when ss.quarters_available >= 4 and ss.eps_pos_quarters = ss.quarters_available then 1 else 0 end) +
  (case when ss.roe_ttm > 15 then 1 else 0 end) +
  (case when ss.fcf_ttm > 0 then 1 else 0 end) +
  (case when ss.peg is not null and ss.peg < 1 then 1 else 0 end) +
  (case when ss.pb is not null and ss.pb < coalesce(pt.pb_max, 3.0) then 1 else 0 end) +
  (case when ss.latest_revenue_yoy_pct is not null and ss.latest_revenue_yoy_pct > 0 then 1 else 0 end)
  as score
from holdings_with_type h
left join stock_primary_industry spi on spi.symbol = h.symbol
left join public.industry_pb_threshold pt on pt.industry = spi.industry
left join public.v_stock_score ss on ss.symbol = h.symbol;

-- v_portfolio_summary 重建(同 migration 20 結構)
create view public.v_portfolio_summary as
select
  count(*) as positions,
  coalesce(sum(cost_basis), 0) as total_cost,
  coalesce(sum(market_value), 0) as total_value,
  coalesce(sum(unrealized_pnl), 0) as total_pnl,
  case when coalesce(sum(cost_basis), 0) > 0
    then sum(unrealized_pnl) / sum(cost_basis) * 100 else 0
  end as total_pct,
  coalesce(sum(total_cost_with_fee), 0) as net_total_cost,
  coalesce(sum(net_proceeds_if_sold_now), 0) as net_total_value,
  coalesce(sum(net_pnl_est), 0) as net_total_pnl,
  case when coalesce(sum(total_cost_with_fee), 0) > 0
    then sum(net_pnl_est) / sum(total_cost_with_fee) * 100 else 0
  end as net_total_pct
from public.v_holdings_full
where current_price is not null;
