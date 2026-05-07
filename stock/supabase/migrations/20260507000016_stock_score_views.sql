-- v_stock_score:套 Andy 的 5 條規則計分(EPS 連續成長 / ROE>15% / FCF>0 / PEG<1 / PB<2)
-- v_industry_picks:整合動能(v_industry_quotes)+ 基本面(v_stock_score)+ score
-- 排序由 UI 端做(score desc → pct_5d desc)

create or replace view public.v_stock_score as
with ranked as (
  select
    symbol,
    period_end,
    eps,
    net_income,
    total_equity,
    fcf,
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
)
select
  a.symbol,
  a.eps_ttm,
  case when a.eps_ttm_prev is not null and a.eps_ttm_prev > 0
    then ((a.eps_ttm - a.eps_ttm_prev) / a.eps_ttm_prev) * 100
  end as eps_yoy_pct,
  case when le.total_equity is not null and le.total_equity > 0
    then (a.net_income_ttm / le.total_equity) * 100
  end as roe_ttm,
  a.fcf_ttm,
  a.eps_pos_quarters,
  a.quarters_available,
  lv.pe,
  lv.pb,
  lv.dividend_yield,
  case when lv.pe is not null and lv.pe > 0
       and a.eps_ttm_prev is not null and a.eps_ttm_prev > 0
       and a.eps_ttm > a.eps_ttm_prev
    then lv.pe / (((a.eps_ttm - a.eps_ttm_prev) / a.eps_ttm_prev) * 100)
  end as peg,
  (case when a.quarters_available >= 4 and a.eps_pos_quarters = a.quarters_available then 1 else 0 end) +
  (case when le.total_equity > 0 and (a.net_income_ttm / le.total_equity) * 100 > 15 then 1 else 0 end) +
  (case when a.fcf_ttm > 0 then 1 else 0 end) +
  (case when lv.pe > 0 and a.eps_ttm_prev > 0 and a.eps_ttm > a.eps_ttm_prev
              and (lv.pe / (((a.eps_ttm - a.eps_ttm_prev) / a.eps_ttm_prev) * 100)) < 1.0 then 1 else 0 end) +
  (case when lv.pb is not null and lv.pb < 2 then 1 else 0 end)
  as score
from agg a
left join latest_equity le on le.symbol = a.symbol
left join latest_valuation lv on lv.symbol = a.symbol;

create or replace view public.v_industry_picks as
select
  iq.id,
  iq.industry,
  iq.symbol,
  iq.name,
  iq.display_order,
  iq.current_price,
  iq.trade_date,
  iq.is_provisional,
  iq.pct_5d,
  iq.pct_20d,
  ss.eps_ttm,
  ss.eps_yoy_pct,
  ss.roe_ttm,
  ss.fcf_ttm,
  ss.eps_pos_quarters,
  ss.quarters_available,
  ss.pe,
  ss.pb,
  ss.peg,
  ss.dividend_yield,
  coalesce(ss.score, 0) as score
from public.v_industry_quotes iq
left join public.v_stock_score ss on ss.symbol = iq.symbol;
