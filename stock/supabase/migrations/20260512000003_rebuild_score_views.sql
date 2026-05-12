-- M8: 重建 v_stock_score + v_industry_picks
--
-- 變更:
-- 1. 移除「法人預估 forecast」邏輯(industry_stocks.analyst_forecast_eps_growth_pct 已 drop)
-- 2. PEG 計算改為:
--    用「過去 4 季 quarterly EPS YoY 平均」當成 expected growth(取代 forecast)
--    具體做法:對每個 q_rn ∈ [1..4],算 (eps[q_rn] - eps[q_rn+4]) / abs(eps[q_rn+4]) * 100
--    取四個 quarterly YoY 的「中位數」(median)— 比 mean 更耐 outlier
-- 3. peg_basis 改為 'avg_q_yoy' / 'last_q_yoy' / 'ttm_yoy' 三層 fallback
-- 4. 保留 forecast_eps_yoy_pct 欄位輸出(永遠 NULL),讓下游 v_holdings_full(M8.5)backward-compat 不壞
--
-- 為什麼用 median 而不是 mean:
-- - quarterly EPS YoY 可能因為單季 base 接近 0 而爆值
-- - median 比 mean 穩健,4 個值的 median = (sorted[2]+sorted[3])/2

-- cascade 也會砍掉 v_holdings_full / v_portfolio_summary(本 migration 末會重建)
drop view if exists public.v_industry_picks cascade;
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
    sum(case when q_rn = 2 then eps end) as eps_q2,
    sum(case when q_rn = 3 then eps end) as eps_q3,
    sum(case when q_rn = 4 then eps end) as eps_q4,
    sum(case when q_rn = 5 then eps end) as eps_q5,
    sum(case when q_rn = 6 then eps end) as eps_q6,
    sum(case when q_rn = 7 then eps end) as eps_q7,
    sum(case when q_rn = 8 then eps end) as eps_q8,
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
),
-- quarterly YoY:對 q1..q4 各算 (q[i] - q[i+4]) / abs(q[i+4]) * 100
-- 然後對 4 個 YoY 取中位數
quarterly_yoys as (
  select
    a.symbol,
    a.eps_q1, a.eps_q2, a.eps_q3, a.eps_q4,
    a.eps_q5, a.eps_q6, a.eps_q7, a.eps_q8,
    case when a.eps_q5 is not null and abs(a.eps_q5) > 0
      then (a.eps_q1 - a.eps_q5) / abs(a.eps_q5) * 100 end as yoy_q1,
    case when a.eps_q6 is not null and abs(a.eps_q6) > 0
      then (a.eps_q2 - a.eps_q6) / abs(a.eps_q6) * 100 end as yoy_q2,
    case when a.eps_q7 is not null and abs(a.eps_q7) > 0
      then (a.eps_q3 - a.eps_q7) / abs(a.eps_q7) * 100 end as yoy_q3,
    case when a.eps_q8 is not null and abs(a.eps_q8) > 0
      then (a.eps_q4 - a.eps_q8) / abs(a.eps_q8) * 100 end as yoy_q4
  from agg a
),
quarterly_yoy_median as (
  -- percentile_cont(0.5) 在 4 個元素時 = (sorted[2]+sorted[3])/2,
  -- 對 NULL 自動 skip(percentile_cont 內部會 ignore NULL)
  select
    symbol,
    percentile_cont(0.5) within group (
      order by yoy_value
    ) as median_yoy
  from (
    select symbol, yoy_q1 as yoy_value from quarterly_yoys where yoy_q1 is not null
    union all
    select symbol, yoy_q2 from quarterly_yoys where yoy_q2 is not null
    union all
    select symbol, yoy_q3 from quarterly_yoys where yoy_q3 is not null
    union all
    select symbol, yoy_q4 from quarterly_yoys where yoy_q4 is not null
  ) u
  group by symbol
)
select
  a.symbol,
  a.eps_ttm,
  case when a.eps_ttm_prev is not null and abs(a.eps_ttm_prev) > 0
    then ((a.eps_ttm - a.eps_ttm_prev) / abs(a.eps_ttm_prev)) * 100
  end as eps_yoy_pct,
  case when a.eps_q5 is not null and abs(a.eps_q5) > 0
    then ((a.eps_q1 - a.eps_q5) / abs(a.eps_q5)) * 100
  end as last_q_eps_yoy_pct,
  -- forecast_eps_yoy_pct 永遠 null(下游 view 仍可 SELECT 它,backward-compat)
  null::numeric as forecast_eps_yoy_pct,
  qm.median_yoy as avg_q_eps_yoy_pct,  -- 「過去 4 季 EPS YoY 平均(中位數)」
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
  -- PEG fallback chain:median_q_yoy → last_q_yoy → ttm_yoy
  case
    when lv.pe > 0 and qm.median_yoy is not null and qm.median_yoy > 0
      then lv.pe / qm.median_yoy
    when lv.pe > 0 and a.eps_q5 > 0 and a.eps_q1 > a.eps_q5
      then lv.pe / (((a.eps_q1 - a.eps_q5) / a.eps_q5) * 100)
    when lv.pe > 0 and a.eps_ttm_prev > 0 and a.eps_ttm > a.eps_ttm_prev
      then lv.pe / (((a.eps_ttm - a.eps_ttm_prev) / a.eps_ttm_prev) * 100)
  end as peg,
  case
    when qm.median_yoy is not null and qm.median_yoy > 0 then 'avg_q_yoy'
    when a.eps_q5 is not null and a.eps_q5 > 0 and a.eps_q1 > a.eps_q5 then 'last_q_yoy'
    when a.eps_ttm_prev is not null and a.eps_ttm_prev > 0 and a.eps_ttm > a.eps_ttm_prev then 'ttm_yoy'
    else null
  end as peg_basis,
  -- 月營收 YoY
  ra.latest_period as latest_revenue_period,
  ra.latest_revenue,
  case when ra.latest_revenue_prev_year is not null and ra.latest_revenue_prev_year > 0
    then ((ra.latest_revenue - ra.latest_revenue_prev_year) / ra.latest_revenue_prev_year) * 100
  end as latest_revenue_yoy_pct
from agg a
left join latest_equity le on le.symbol = a.symbol
left join latest_valuation lv on lv.symbol = a.symbol
left join revenue_agg ra on ra.symbol = a.symbol
left join quarterly_yoy_median qm on qm.symbol = a.symbol;

-- v_industry_picks:同 22 結構,移除 forecast_eps_yoy_pct 那一行
create view public.v_industry_picks as
select
  iq.id, iq.industry, iq.symbol, iq.name, iq.display_order,
  iq.current_price, iq.trade_date, iq.is_provisional,
  iq.pct_5d, iq.pct_20d,
  ss.eps_ttm, ss.eps_yoy_pct, ss.last_q_eps_yoy_pct, ss.avg_q_eps_yoy_pct,
  ss.forecast_eps_yoy_pct,  -- always null
  ss.roe_ttm, ss.fcf_ttm, ss.eps_pos_quarters, ss.quarters_available,
  ss.gross_margin_pct, ss.gross_margin_yoy_pp,
  ss.pe, ss.pb, ss.peg, ss.peg_basis, ss.dividend_yield,
  ss.latest_revenue_period, ss.latest_revenue, ss.latest_revenue_yoy_pct,
  pt.pb_max as pb_threshold,
  -- 6 條規則(score 仍 0-6)
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

-- 重建被 cascade 砍掉的 v_holdings_full 與 v_portfolio_summary
-- 結構同 migration 22(monthly revenue 版),但 forecast_eps_yoy_pct 直接從新 v_stock_score 拿(永遠 null)
-- M8.5 migration 33 套用後會被覆寫(M8.5 已改 base 為 v_holdings_pnl 吃 v_holdings_current),
-- 中間期間維持 UI 不壞
create or replace view public.v_holdings_full as
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
  ss.avg_q_eps_yoy_pct,
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
