-- 月營收資料層 + 加進 score(從 5 條變 6 條規則)

create table public.stock_monthly_revenue (
  symbol text not null,
  period_year int not null,
  period_month int not null,
  revenue numeric(20,0) not null,
  fetched_at timestamptz not null default now(),
  primary key (symbol, period_year, period_month)
);
create index idx_smr_recent on public.stock_monthly_revenue (period_year desc, period_month desc);
alter table public.stock_monthly_revenue enable row level security;

-- 重建 v_stock_score / v_industry_picks / v_holdings_full,加月營收 YoY 並改 score 為 0-6
drop view if exists public.v_holdings_full;
drop view if exists public.v_industry_picks;
drop view if exists public.v_stock_score cascade;

create view public.v_stock_score as
with ranked as (
  select symbol, period_end, eps, net_income, revenue, gross_profit, total_equity, fcf,
    row_number() over (partition by symbol order by period_end desc) as q_rn
  from public.stock_fundamentals_quarterly
),
agg as (
  select
    symbol,
    sum(case when q_rn between 1 and 4 then net_income end) as net_income_ttm,
    sum(case when q_rn between 1 and 4 then fcf end) as fcf_ttm,
    sum(case when q_rn between 1 and 4 then eps end) as eps_ttm,
    sum(case when q_rn between 5 and 8 then eps end) as eps_ttm_prev,
    sum(case when q_rn = 1 then eps end) as eps_q1,
    sum(case when q_rn = 5 then eps end) as eps_q5,
    sum(case when q_rn = 1 then gross_profit end) as gp_q1,
    sum(case when q_rn = 1 then revenue end) as rev_q1,
    sum(case when q_rn = 5 then gross_profit end) as gp_q5,
    sum(case when q_rn = 5 then revenue end) as rev_q5,
    count(case when q_rn between 1 and 8 and eps > 0 then 1 end) as eps_pos_quarters,
    count(case when q_rn between 1 and 8 then 1 end) as quarters_available
  from ranked
  group by symbol
),
latest_equity as (
  select symbol, total_equity from ranked where q_rn = 1
),
latest_valuation as (
  select distinct on (symbol) symbol, pe, pb, dividend_yield
  from public.stock_pe_pb_daily
  order by symbol, trade_date desc
),
forecast_lookup as (
  select symbol, max(analyst_forecast_eps_growth_pct) as forecast_g
  from public.industry_stocks
  where analyst_forecast_eps_growth_pct is not null
  group by symbol
),
revenue_ranked as (
  select symbol, period_year, period_month, revenue,
    row_number() over (partition by symbol order by period_year desc, period_month desc) as m_rn
  from public.stock_monthly_revenue
),
revenue_agg as (
  select
    symbol,
    max(case when m_rn = 1 then period_year * 100 + period_month end) as latest_period,
    max(case when m_rn = 1 then revenue end) as latest_revenue,
    max(case when m_rn = 13 then revenue end) as latest_revenue_prev_year
  from revenue_ranked
  where m_rn <= 13
  group by symbol
)
select
  a.symbol,
  a.eps_ttm,
  case when a.eps_ttm_prev is not null and a.eps_ttm_prev > 0
    then ((a.eps_ttm - a.eps_ttm_prev) / a.eps_ttm_prev) * 100
  end as eps_yoy_pct,
  case when a.eps_q5 is not null and a.eps_q5 > 0
    then ((a.eps_q1 - a.eps_q5) / a.eps_q5) * 100
  end as last_q_eps_yoy_pct,
  fl.forecast_g as forecast_eps_yoy_pct,
  case when le.total_equity > 0
    then (a.net_income_ttm / le.total_equity) * 100
  end as roe_ttm,
  a.fcf_ttm,
  a.eps_pos_quarters,
  a.quarters_available,
  case when a.rev_q1 > 0 then a.gp_q1 / a.rev_q1 * 100 end as gross_margin_pct,
  case when a.rev_q1 > 0 and a.rev_q5 > 0
    then (a.gp_q1 / a.rev_q1 - a.gp_q5 / a.rev_q5) * 100
  end as gross_margin_yoy_pp,
  lv.pe, lv.pb, lv.dividend_yield,
  case
    when lv.pe > 0 and fl.forecast_g is not null and fl.forecast_g > 0
      then lv.pe / fl.forecast_g
    when lv.pe > 0 and a.eps_q5 > 0 and a.eps_q1 > a.eps_q5
      then lv.pe / (((a.eps_q1 - a.eps_q5) / a.eps_q5) * 100)
    when lv.pe > 0 and a.eps_ttm_prev > 0 and a.eps_ttm > a.eps_ttm_prev
      then lv.pe / (((a.eps_ttm - a.eps_ttm_prev) / a.eps_ttm_prev) * 100)
  end as peg,
  case
    when fl.forecast_g is not null then 'forecast'
    when a.eps_q5 is not null and a.eps_q5 > 0 and a.eps_q1 > a.eps_q5 then 'last_q_yoy'
    when a.eps_ttm_prev is not null and a.eps_ttm_prev > 0 and a.eps_ttm > a.eps_ttm_prev then 'ttm_yoy'
    else null
  end as peg_basis,
  -- 月營收 YoY (新)
  ra.latest_period as latest_revenue_period,
  ra.latest_revenue,
  case when ra.latest_revenue_prev_year is not null and ra.latest_revenue_prev_year > 0
    then ((ra.latest_revenue - ra.latest_revenue_prev_year) / ra.latest_revenue_prev_year) * 100
  end as latest_revenue_yoy_pct
from agg a
left join latest_equity le on le.symbol = a.symbol
left join latest_valuation lv on lv.symbol = a.symbol
left join forecast_lookup fl on fl.symbol = a.symbol
left join revenue_agg ra on ra.symbol = a.symbol;

create view public.v_industry_picks as
select
  iq.id, iq.industry, iq.symbol, iq.name, iq.display_order,
  iq.current_price, iq.trade_date, iq.is_provisional,
  iq.pct_5d, iq.pct_20d,
  ss.eps_ttm, ss.eps_yoy_pct, ss.last_q_eps_yoy_pct, ss.forecast_eps_yoy_pct,
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
  h.id, h.symbol, h.qty, h.avg_cost, h.current_price, h.price_date, h.is_provisional,
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

-- portfolio summary 也要重建因為 dependent
create or replace view public.v_portfolio_summary as
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

-- pg_cron:每週一 04:00 Taipei (UTC Sunday 20:00)
select cron.schedule(
  'fetch-finmind-monthly-revenue-weekly',
  '0 20 * * 0',
  $$
  select net.http_post(
    url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-monthly-revenue',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_auth' limit 1),
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 300000
  );
  $$
);
