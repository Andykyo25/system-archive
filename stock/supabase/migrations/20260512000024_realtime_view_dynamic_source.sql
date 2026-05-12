-- M8.3 patch:v_latest_price_realtime 內的 source 從 hard-code 'yahoo' 改成動態欄位
--
-- 為什麼:Yahoo Finance public quote API 2024 起需 cookie+crumb auth,server-to-server 401 擋。
--   實作從 Yahoo 換成 TWSE MIS 即時揭示(EF 名稱保留 fetch-yahoo-intraday)。
--   寫入 price_intraday_cache.source='twse_mis',view 需動態取 source 才能正確顯示。
--
-- 連動:cascade 重建依賴 v_latest_price_realtime 的全部 view
--   (v_industry_quotes / v_etf_picks / v_industry_picks /
--    v_holdings_pnl / v_holdings_full / v_portfolio_summary /
--    v_holdings_summary)

drop view if exists public.v_latest_price_realtime cascade;

create view public.v_latest_price_realtime as
with intraday_latest as (
  select distinct on (symbol) symbol, price, quoted_at, market_state, source
  from public.price_intraday_cache
  where quoted_at >= now() - interval '30 minutes'
  order by symbol, quoted_at desc
),
daily_today as (
  select distinct on (symbol) symbol, close, trade_date, is_provisional, source
  from public.price_daily
  where trade_date = current_date
  order by symbol, trade_date desc
),
daily_recent as (
  select distinct on (symbol) symbol, close, trade_date, is_provisional, source
  from public.price_daily
  where trade_date < current_date
  order by symbol, trade_date desc
),
all_symbols as (
  select symbol from intraday_latest union select symbol from daily_recent
)
select
  s.symbol,
  coalesce(i.price, dt.close, dr.close)::numeric(12,4) as current_price,
  case
    when i.price is not null then i.quoted_at
    when dt.close is not null then dt.trade_date::timestamptz
    when dr.close is not null then dr.trade_date::timestamptz
  end as as_of_ts,
  case
    when i.price is not null then null::date
    when dt.close is not null then dt.trade_date
    when dr.close is not null then dr.trade_date
  end as trade_date,
  case
    when i.price is not null then i.source              -- 動態:twse_mis / yahoo / 任何 intraday source
    when dt.close is not null then 'twse_today'
    when dr.close is not null then 'twse_yesterday'
  end as source,
  case
    when i.price is not null then false
    when dt.close is not null then dt.is_provisional
    when dr.close is not null then dr.is_provisional
  end as is_provisional,
  i.market_state
from all_symbols s
left join intraday_latest i on i.symbol = s.symbol
left join daily_today dt on dt.symbol = s.symbol
left join daily_recent dr on dr.symbol = s.symbol;

-- cascade 重建依賴 view(同 migration 23 + 32 + 33 結構,只是 source 動態化)
create view public.v_industry_quotes as
with ranked as (
  select symbol, trade_date, close, is_provisional,
    row_number() over (partition by symbol order by trade_date desc) as rn
  from public.price_daily
),
prev_5d as (select symbol, close as close_5d_ago from ranked where rn = 6),
prev_20d as (select symbol, close as close_20d_ago from ranked where rn = 21)
select
  i.id, i.industry, i.symbol, i.name, i.display_order,
  lp.current_price, lp.trade_date, lp.is_provisional,
  lp.as_of_ts, lp.source as price_source, lp.market_state,
  p5.close_5d_ago, p20.close_20d_ago,
  case when lp.current_price is not null and p5.close_5d_ago is not null and p5.close_5d_ago > 0
    then ((lp.current_price - p5.close_5d_ago) / p5.close_5d_ago) * 100 end as pct_5d,
  case when lp.current_price is not null and p20.close_20d_ago is not null and p20.close_20d_ago > 0
    then ((lp.current_price - p20.close_20d_ago) / p20.close_20d_ago) * 100 end as pct_20d
from public.industry_stocks i
left join public.v_latest_price_realtime lp on lp.symbol = i.symbol
left join prev_5d p5 on p5.symbol = i.symbol
left join prev_20d p20 on p20.symbol = i.symbol;

create view public.v_etf_picks as
with ranked as (
  select symbol, trade_date, close, is_provisional,
    row_number() over (partition by symbol order by trade_date desc) as rn
  from public.price_daily
),
prev_5d as (select symbol, close as close_5d_ago from ranked where rn = 6),
prev_20d as (select symbol, close as close_20d_ago from ranked where rn = 21),
volume_avg as (
  select symbol, avg(volume) as avg_20d_volume from public.price_daily
  where trade_date >= current_date - interval '30 days' group by symbol
),
latest_valuation as (
  select distinct on (symbol) symbol, dividend_yield, pe, pb
  from public.stock_pe_pb_daily order by symbol, trade_date desc
)
select
  e.symbol, e.name, e.category, e.expense_ratio, e.fund_size_billion, e.is_active_etf, e.notes,
  lp.current_price, lp.trade_date, lp.is_provisional,
  lp.as_of_ts, lp.source as price_source, lp.market_state,
  case when lp.current_price is not null and p5.close_5d_ago is not null and p5.close_5d_ago > 0
    then ((lp.current_price - p5.close_5d_ago) / p5.close_5d_ago) * 100 end as pct_5d,
  case when lp.current_price is not null and p20.close_20d_ago is not null and p20.close_20d_ago > 0
    then ((lp.current_price - p20.close_20d_ago) / p20.close_20d_ago) * 100 end as pct_20d,
  v.dividend_yield, v.pe, v.pb, vol.avg_20d_volume,
  (case when e.expense_ratio is not null and e.expense_ratio < 0.5 then 1 else 0 end) +
  (case when e.fund_size_billion is not null and e.fund_size_billion > 100 then 1 else 0 end) +
  (case when v.dividend_yield is not null and v.dividend_yield > 4 then 1 else 0 end) +
  (case when lp.current_price is not null and p5.close_5d_ago is not null and lp.current_price > p5.close_5d_ago then 1 else 0 end) +
  (case when vol.avg_20d_volume is not null and vol.avg_20d_volume > 1000000 then 1 else 0 end)
  as score
from public.etf_metadata e
left join public.v_latest_price_realtime lp on lp.symbol = e.symbol
left join prev_5d p5 on p5.symbol = e.symbol
left join prev_20d p20 on p20.symbol = e.symbol
left join volume_avg vol on vol.symbol = e.symbol
left join latest_valuation v on v.symbol = e.symbol;

create view public.v_industry_picks as
select
  iq.id, iq.industry, iq.symbol, iq.name, iq.display_order,
  iq.current_price, iq.trade_date, iq.is_provisional,
  iq.as_of_ts, iq.price_source, iq.market_state,
  iq.pct_5d, iq.pct_20d,
  ss.eps_ttm, ss.eps_yoy_pct, ss.last_q_eps_yoy_pct, ss.avg_q_eps_yoy_pct,
  ss.forecast_eps_yoy_pct,
  ss.roe_ttm, ss.fcf_ttm, ss.eps_pos_quarters, ss.quarters_available,
  ss.gross_margin_pct, ss.gross_margin_yoy_pp,
  ss.pe, ss.pb, ss.peg, ss.peg_basis, ss.dividend_yield,
  ss.latest_revenue_period, ss.latest_revenue, ss.latest_revenue_yoy_pct,
  pt.pb_max as pb_threshold,
  (case when ss.quarters_available >= 4 and ss.eps_pos_quarters = ss.quarters_available then 1 else 0 end) +
  (case when ss.roe_ttm > 15 then 1 else 0 end) +
  (case when ss.fcf_ttm > 0 then 1 else 0 end) +
  (case when ss.peg is not null and ss.peg < 1 then 1 else 0 end) +
  (case when ss.pb is not null and pt.pb_max is not null and ss.pb < pt.pb_max then 1 else 0 end) +
  (case when ss.latest_revenue_yoy_pct is not null and ss.latest_revenue_yoy_pct > 0 then 1 else 0 end)
  as score
from public.v_industry_quotes iq
left join public.v_stock_score ss on ss.symbol = iq.symbol
left join public.industry_pb_threshold pt on pt.industry = iq.industry;

create view public.v_holdings_pnl as
with first_buy as (
  select symbol, min(txn_date) as opened_at
  from public.holdings_transactions where txn_type = 'BUY' group by symbol
),
latest_note as (
  select distinct on (symbol) symbol, note
  from public.holdings_transactions
  where note is not null and note <> ''
  order by symbol, txn_date desc, created_at desc
)
select
  c.symbol, c.net_qty as qty, c.avg_cost,
  lp.current_price, lp.trade_date as price_date, lp.is_provisional,
  lp.as_of_ts, lp.source as price_source, lp.market_state,
  case when lp.current_price is not null then (lp.current_price - c.avg_cost) * c.net_qty end as unrealized_pnl,
  case when lp.current_price is not null and c.avg_cost > 0
    then ((lp.current_price - c.avg_cost) / c.avg_cost) * 100 end as unrealized_pct,
  case when lp.current_price is not null then c.net_qty * lp.current_price end as market_value,
  c.total_cost as cost_basis,
  fb.opened_at, ln.note
from public.v_holdings_current c
left join public.v_latest_price_realtime lp on lp.symbol = c.symbol
left join first_buy fb on fb.symbol = c.symbol
left join latest_note ln on ln.symbol = c.symbol;

create view public.v_holdings_full as
with settings as (
  select
    (select value from public.app_settings where key = 'commission_discount') *
      (select value from public.app_settings where key = 'commission_base_rate') as fee_rate,
    (select value from public.app_settings where key = 'sell_tax_stock') as tax_stock,
    (select value from public.app_settings where key = 'sell_tax_etf') as tax_etf
),
stock_primary_industry as (
  select distinct on (symbol) symbol, industry from public.industry_stocks order by symbol, display_order
),
holdings_with_type as (
  select
    h.*,
    case when h.symbol ~ '^00\d+' then 'etf' else 'stock' end as stock_type,
    case when h.symbol ~ '^00\d+' then s.tax_etf else s.tax_stock end as sell_tax_rate,
    s.fee_rate as commission_rate
  from public.v_holdings_pnl h cross join settings s
)
select
  h.symbol, h.qty, h.avg_cost, h.current_price, h.price_date, h.is_provisional,
  h.as_of_ts, h.price_source, h.market_state,
  h.unrealized_pnl, h.unrealized_pct, h.market_value, h.cost_basis,
  h.opened_at, h.note,
  h.stock_type, h.commission_rate, h.sell_tax_rate,
  h.qty * h.avg_cost * (1 + h.commission_rate) as total_cost_with_fee,
  case when h.current_price is not null then h.qty * h.current_price * (1 - h.commission_rate - h.sell_tax_rate) end as net_proceeds_if_sold_now,
  case when h.current_price is not null then
    h.qty * h.current_price * (1 - h.commission_rate - h.sell_tax_rate) - h.qty * h.avg_cost * (1 + h.commission_rate)
  end as net_pnl_est,
  case when h.current_price is not null and h.qty * h.avg_cost > 0 then
    (h.qty * h.current_price * (1 - h.commission_rate - h.sell_tax_rate) - h.qty * h.avg_cost * (1 + h.commission_rate))
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

create view public.v_portfolio_summary as
select
  count(*) as positions,
  coalesce(sum(cost_basis), 0) as total_cost,
  coalesce(sum(market_value), 0) as total_value,
  coalesce(sum(unrealized_pnl), 0) as total_pnl,
  case when coalesce(sum(cost_basis), 0) > 0 then sum(unrealized_pnl) / sum(cost_basis) * 100 else 0 end as total_pct,
  coalesce(sum(total_cost_with_fee), 0) as net_total_cost,
  coalesce(sum(net_proceeds_if_sold_now), 0) as net_total_value,
  coalesce(sum(net_pnl_est), 0) as net_total_pnl,
  case when coalesce(sum(total_cost_with_fee), 0) > 0 then sum(net_pnl_est) / sum(total_cost_with_fee) * 100 else 0 end as net_total_pct
from public.v_holdings_full where current_price is not null;

create or replace view public.v_holdings_summary as
with txn_agg as (
  select symbol,
    sum(case when txn_type = 'BUY'  then qty else 0 end) as buy_qty,
    sum(case when txn_type = 'SELL' then qty else 0 end) as sell_qty,
    sum(case when txn_type = 'BUY'  then qty * price + fee else 0 end) as invested,
    sum(case when txn_type = 'SELL' then qty * price - fee - tax else 0 end) as recovered
  from public.holdings_transactions group by symbol
),
realized as (
  select coalesce(sum(realized_pnl), 0) as total_realized_pnl from public.v_holdings_realized
),
unrealized as (
  select coalesce(sum(case when lp.current_price is not null then (lp.current_price - c.avg_cost) * c.net_qty end), 0) as total_unrealized_pnl
  from public.v_holdings_current c
  left join public.v_latest_price_realtime lp on lp.symbol = c.symbol
)
select
  (select total_realized_pnl from realized) as total_realized_pnl,
  (select total_unrealized_pnl from unrealized) as total_unrealized_pnl,
  (select total_realized_pnl from realized) + (select total_unrealized_pnl from unrealized) as total_pnl,
  coalesce((select sum(invested) from txn_agg), 0) as total_invested,
  coalesce((select sum(recovered) from txn_agg), 0) as total_recovered,
  (select count(*) from public.v_holdings_current) as count_holdings,
  coalesce((select count(*) from txn_agg where buy_qty > 0 and buy_qty - sell_qty = 0), 0) as count_closed;
