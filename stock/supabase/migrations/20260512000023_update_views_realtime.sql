-- M8.3:把既有 view 的「現價」來源換成 v_latest_price_realtime
--
-- 範圍(只動 M8.3 範圍內既存 view,M8.5 自己新建的 view 由 M8.5 處理):
--   - v_holdings_pnl
--   - v_industry_quotes
--   - v_etf_picks
--   - v_holdings_full
--   - v_portfolio_summary(因為 dependent on v_holdings_full,重建)
--
-- 設計:
--   - 「現價」這格從 v_latest_price_realtime 拿(yahoo / twse_today / twse_yesterday 三層 fallback)
--   - 歷史比較基準(5d / 20d 前 close)維持從 price_daily ranked 算,不能用 realtime 取代
--     (否則「5 日漲幅」會把比較基準變成 realtime,失準)
--   - surface as_of_ts、source 給 UI 顯示「資料來源 + 時間」
--
-- 注意:既有 v_holdings_pnl / v_industry_quotes 等下游 view 與 UI code 仰賴特定欄位,
--      我們只「新增」as_of_ts / source / market_state,不刪/不改既有欄位 → backward compatible

-- 先 drop 依賴順序(由上往下)
drop view if exists public.v_portfolio_summary cascade;
drop view if exists public.v_holdings_full cascade;
drop view if exists public.v_industry_picks cascade;
drop view if exists public.v_etf_picks cascade;
drop view if exists public.v_industry_quotes cascade;
drop view if exists public.v_holdings_pnl cascade;

------------------------------------------------------------
-- v_holdings_pnl:現價改吃 realtime,多吐 as_of_ts / source / market_state
------------------------------------------------------------
create view public.v_holdings_pnl as
select
  h.id,
  h.symbol,
  h.qty,
  h.avg_cost,
  lp.current_price,
  lp.trade_date as price_date,
  lp.is_provisional,
  lp.as_of_ts,
  lp.source as price_source,
  lp.market_state,
  case when lp.current_price is not null
    then (lp.current_price - h.avg_cost) * h.qty
  end as unrealized_pnl,
  case when lp.current_price is not null and h.avg_cost > 0
    then ((lp.current_price - h.avg_cost) / h.avg_cost) * 100
  end as unrealized_pct,
  case when lp.current_price is not null then h.qty * lp.current_price end as market_value,
  h.qty * h.avg_cost as cost_basis,
  h.opened_at,
  h.note
from public.holdings h
left join public.v_latest_price_realtime lp on lp.symbol = h.symbol
where h.closed_at is null;

------------------------------------------------------------
-- v_industry_quotes:現價換 realtime,5d / 20d 比較基準保留 price_daily
------------------------------------------------------------
create view public.v_industry_quotes as
with ranked as (
  select
    symbol,
    trade_date,
    close,
    is_provisional,
    row_number() over (partition by symbol order by trade_date desc) as rn
  from public.price_daily
),
prev_5d as (
  select symbol, close as close_5d_ago from ranked where rn = 6
),
prev_20d as (
  select symbol, close as close_20d_ago from ranked where rn = 21
)
select
  i.id,
  i.industry,
  i.symbol,
  i.name,
  i.display_order,
  lp.current_price,
  lp.trade_date,
  lp.is_provisional,
  lp.as_of_ts,
  lp.source as price_source,
  lp.market_state,
  p5.close_5d_ago,
  p20.close_20d_ago,
  case when lp.current_price is not null and p5.close_5d_ago is not null and p5.close_5d_ago > 0
    then ((lp.current_price - p5.close_5d_ago) / p5.close_5d_ago) * 100
  end as pct_5d,
  case when lp.current_price is not null and p20.close_20d_ago is not null and p20.close_20d_ago > 0
    then ((lp.current_price - p20.close_20d_ago) / p20.close_20d_ago) * 100
  end as pct_20d
from public.industry_stocks i
left join public.v_latest_price_realtime lp on lp.symbol = i.symbol
left join prev_5d p5 on p5.symbol = i.symbol
left join prev_20d p20 on p20.symbol = i.symbol;

------------------------------------------------------------
-- v_etf_picks:同上,現價換 realtime
------------------------------------------------------------
create view public.v_etf_picks as
with ranked as (
  select symbol, trade_date, close, is_provisional,
    row_number() over (partition by symbol order by trade_date desc) as rn
  from public.price_daily
),
prev_5d as (select symbol, close as close_5d_ago from ranked where rn = 6),
prev_20d as (select symbol, close as close_20d_ago from ranked where rn = 21),
volume_avg as (
  select symbol, avg(volume) as avg_20d_volume
  from public.price_daily
  where trade_date >= current_date - interval '30 days'
  group by symbol
),
latest_valuation as (
  select distinct on (symbol) symbol, dividend_yield, pe, pb
  from public.stock_pe_pb_daily
  order by symbol, trade_date desc
)
select
  e.symbol, e.name, e.category, e.expense_ratio, e.fund_size_billion, e.is_active_etf, e.notes,
  lp.current_price,
  lp.trade_date,
  lp.is_provisional,
  lp.as_of_ts,
  lp.source as price_source,
  lp.market_state,
  case when lp.current_price is not null and p5.close_5d_ago is not null and p5.close_5d_ago > 0
    then ((lp.current_price - p5.close_5d_ago) / p5.close_5d_ago) * 100
  end as pct_5d,
  case when lp.current_price is not null and p20.close_20d_ago is not null and p20.close_20d_ago > 0
    then ((lp.current_price - p20.close_20d_ago) / p20.close_20d_ago) * 100
  end as pct_20d,
  v.dividend_yield, v.pe, v.pb,
  vol.avg_20d_volume,
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

------------------------------------------------------------
-- v_industry_picks:依賴 v_industry_quotes,把 as_of_ts / price_source 傳出去
------------------------------------------------------------
create view public.v_industry_picks as
select
  iq.id, iq.industry, iq.symbol, iq.name, iq.display_order,
  iq.current_price, iq.trade_date, iq.is_provisional,
  iq.as_of_ts, iq.price_source, iq.market_state,
  iq.pct_5d, iq.pct_20d,
  ss.eps_ttm, ss.eps_yoy_pct, ss.last_q_eps_yoy_pct, ss.avg_q_eps_yoy_pct,
  ss.forecast_eps_yoy_pct,  -- M8 移除手動 forecast,改回傳 null,但保留 column 供下游 backward-compat
  ss.roe_ttm, ss.fcf_ttm, ss.eps_pos_quarters, ss.quarters_available,
  ss.gross_margin_pct, ss.gross_margin_yoy_pp,
  ss.pe, ss.pb, ss.peg, ss.peg_basis, ss.dividend_yield,
  ss.latest_revenue_period, ss.latest_revenue, ss.latest_revenue_yoy_pct,
  pt.pb_max as pb_threshold,
  -- 6 條規則(0-6 分)
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

------------------------------------------------------------
-- v_holdings_full:依賴 v_holdings_pnl,額外加 net / fee / score
-- (沿用 monthly_revenue migration 內定義,把現價來源已自動換成 realtime
--  因為 v_holdings_pnl 已改)
------------------------------------------------------------
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
  h.id, h.symbol, h.qty, h.avg_cost,
  h.current_price, h.price_date, h.is_provisional,
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

------------------------------------------------------------
-- v_portfolio_summary:重建,沿用 monthly_revenue migration 內版本
------------------------------------------------------------
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
