-- v2 評分規則優化 + 持股完整分析
--   1. 產業相對 P/B 門檻(IC 設計 < 8、AI 伺服器 < 5、傳產 < 2)
--   2. PEG 用 forecast > last_q_yoy > ttm_yoy 優先順序
--   3. 加毛利率 + 毛利率 YoY pp(顯示用,不評分)
--   4. industry_stocks 新欄位 analyst_forecast_eps_growth_pct(讓 Andy 手動填預估)
--   5. v_holdings_full:持股 + 完整基本面 + score
--
-- 必須用 DROP CASCADE 因為要改 view 欄位順序

drop view if exists public.v_holdings_full;
drop view if exists public.v_industry_picks;
drop view if exists public.v_stock_score cascade;

create table if not exists public.industry_pb_threshold (
  industry text primary key,
  pb_max numeric(8,2) not null
);
alter table public.industry_pb_threshold enable row level security;

insert into public.industry_pb_threshold (industry, pb_max) values
  ('半導體封測', 2),
  ('被動元件', 2),
  ('面板', 2),
  ('航運', 2),
  ('生技', 2),
  ('金融', 2),
  ('車用電動車', 3),
  ('記憶體', 3),
  ('AI伺服器', 5),
  ('IC設計', 8)
on conflict (industry) do update set pb_max = excluded.pb_max;

alter table public.industry_stocks
  add column if not exists analyst_forecast_eps_growth_pct numeric(8,2);

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
  lv.pe,
  lv.pb,
  lv.dividend_yield,
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
  end as peg_basis
from agg a
left join latest_equity le on le.symbol = a.symbol
left join latest_valuation lv on lv.symbol = a.symbol
left join forecast_lookup fl on fl.symbol = a.symbol;

create view public.v_industry_picks as
select
  iq.id, iq.industry, iq.symbol, iq.name, iq.display_order,
  iq.current_price, iq.trade_date, iq.is_provisional,
  iq.pct_5d, iq.pct_20d,
  ss.eps_ttm, ss.eps_yoy_pct, ss.last_q_eps_yoy_pct, ss.forecast_eps_yoy_pct,
  ss.roe_ttm, ss.fcf_ttm, ss.eps_pos_quarters, ss.quarters_available,
  ss.gross_margin_pct, ss.gross_margin_yoy_pp,
  ss.pe, ss.pb, ss.peg, ss.peg_basis, ss.dividend_yield,
  pt.pb_max as pb_threshold,
  (case when ss.quarters_available >= 4 and ss.eps_pos_quarters = ss.quarters_available then 1 else 0 end) +
  (case when ss.roe_ttm > 15 then 1 else 0 end) +
  (case when ss.fcf_ttm > 0 then 1 else 0 end) +
  (case when ss.peg is not null and ss.peg < 1 then 1 else 0 end) +
  (case when ss.pb is not null and pt.pb_max is not null and ss.pb < pt.pb_max then 1 else 0 end) as score
from public.v_industry_quotes iq
left join public.v_stock_score ss on ss.symbol = iq.symbol
left join public.industry_pb_threshold pt on pt.industry = iq.industry;

create view public.v_holdings_full as
with stock_primary_industry as (
  select distinct on (symbol) symbol, industry
  from public.industry_stocks
  order by symbol, display_order
)
select
  h.id, h.symbol, h.qty, h.avg_cost, h.current_price, h.price_date, h.is_provisional,
  h.unrealized_pnl, h.unrealized_pct, h.market_value, h.cost_basis,
  h.opened_at, h.note,
  spi.industry as primary_industry,
  ss.eps_ttm, ss.eps_yoy_pct, ss.last_q_eps_yoy_pct, ss.forecast_eps_yoy_pct,
  ss.roe_ttm, ss.fcf_ttm, ss.eps_pos_quarters, ss.quarters_available,
  ss.gross_margin_pct, ss.gross_margin_yoy_pp,
  ss.pe, ss.pb, ss.peg, ss.peg_basis, ss.dividend_yield,
  coalesce(pt.pb_max, 3.0::numeric(8,2)) as pb_threshold,
  (case when ss.quarters_available >= 4 and ss.eps_pos_quarters = ss.quarters_available then 1 else 0 end) +
  (case when ss.roe_ttm > 15 then 1 else 0 end) +
  (case when ss.fcf_ttm > 0 then 1 else 0 end) +
  (case when ss.peg is not null and ss.peg < 1 then 1 else 0 end) +
  (case when ss.pb is not null and ss.pb < coalesce(pt.pb_max, 3.0) then 1 else 0 end) as score
from public.v_holdings_pnl h
left join stock_primary_industry spi on spi.symbol = h.symbol
left join public.industry_pb_threshold pt on pt.industry = spi.industry
left join public.v_stock_score ss on ss.symbol = h.symbol;
