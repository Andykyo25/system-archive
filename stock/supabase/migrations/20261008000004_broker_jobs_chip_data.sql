-- Chip-data tables filled by the broker-sync worker's background jobs (Fubon market data API):
--   broker_job_task            progress ledger: which (job, task_key) already ran
--   tdcc_distribution_weekly   TDCC shareholding distribution, reduced to derived values per week
--   etf_holdings_daily         active-ETF constituents per day, with day-over-day changes
--   v_tdcc_latest              latest TDCC period per symbol + week-over-week deltas
--   v_etf_active_flow          per stock: how many active ETFs hold it and recent net adds / cuts
--   v_tdcc_last_date, v_etf_last_date   what the jobs need to resume incrementally
--
-- These are watch-list information, not signals (M10: chip indicators failed PIT validation).
-- Access: service_role only (views bypass RLS, so default grants would expose them via anon).
--
-- Rollback:
--   drop view public.v_etf_last_date, public.v_tdcc_last_date, public.v_etf_active_flow, public.v_tdcc_latest;
--   drop table public.etf_holdings_daily, public.tdcc_distribution_weekly, public.broker_job_task;

create table public.broker_job_task (
  job text not null,
  task_key text not null,
  done_at timestamptz not null default now(),
  rows_written integer not null default 0,   -- -1 = failed; retried after 3 days
  primary key (job, task_key)
);

-- Ratios are percentages of the TDCC custody total. A "lot" is 1,000 shares:
--   big400 = holders of >= 400 lots (>= 400,001 shares), big1000 = >= 1,000 lots,
--   retail50 = holders of <= 50 lots (<= 50,000 shares).
create table public.tdcc_distribution_weekly (
  symbol text not null check (symbol ~ '^[0-9A-Za-z]{4,6}$'),
  data_date date not null,
  holders_total integer,
  shares_total bigint,
  big400_holders integer,
  big400_ratio numeric(6,2),
  big1000_holders integer,
  big1000_ratio numeric(6,2),
  retail50_holders integer,
  retail50_ratio numeric(6,2),
  fetched_at timestamptz not null default now(),
  primary key (symbol, data_date)
);

-- One row per ETF, day and Taiwan stock held. When an ETF drops a stock entirely the worker
-- writes one closing row with quantity = 0 and a negative change (the API itself never shows exits).
create table public.etf_holdings_daily (
  etf_symbol text not null check (etf_symbol ~ '^[0-9A-Za-z]{4,8}$'),
  data_date date not null,
  symbol text not null,
  quantity bigint not null,
  weight numeric(8,3),
  quantity_change bigint,
  weight_change numeric(8,3),
  primary key (etf_symbol, data_date, symbol)
);
create index etf_holdings_daily_symbol_idx on public.etf_holdings_daily (symbol, data_date desc);

alter table public.broker_job_task enable row level security;
alter table public.tdcc_distribution_weekly enable row level security;
alter table public.etf_holdings_daily enable row level security;
revoke all on public.broker_job_task, public.tdcc_distribution_weekly, public.etf_holdings_daily from anon, authenticated;
grant select, insert, update, delete on public.broker_job_task, public.tdcc_distribution_weekly, public.etf_holdings_daily to service_role;

create or replace view public.v_tdcc_latest as
with r as (
  select t.*, row_number() over (partition by t.symbol order by t.data_date desc) as rn
  from public.tdcc_distribution_weekly t
)
select a.symbol,
       a.data_date,
       a.holders_total,
       a.shares_total,
       a.big400_holders,
       a.big400_ratio,
       a.big1000_holders,
       a.big1000_ratio,
       a.retail50_holders,
       a.retail50_ratio,
       b.data_date as prev_date,
       a.big400_ratio - b.big400_ratio as big400_wow,
       a.big1000_ratio - b.big1000_ratio as big1000_wow,
       a.retail50_ratio - b.retail50_ratio as retail50_wow,
       a.holders_total - b.holders_total as holders_wow
from r a
left join r b on b.symbol = a.symbol and b.rn = 2
where a.rn = 1;

-- Day ranks are global (distinct dates across all ETFs). Changes are summed over the last
-- 1 / 5 / 20 data dates; exits are included because the worker writes closing rows.
create or replace view public.v_etf_active_flow as
with d as (
  select data_date, dense_rank() over (order by data_date desc) as rk
  from (select distinct data_date from public.etf_holdings_daily) x
),
cur as (
  select h.symbol,
         count(*) filter (where h.quantity > 0) as n_etf,
         coalesce(sum(h.quantity), 0) as qty
  from public.etf_holdings_daily h
  join d on d.data_date = h.data_date and d.rk = 1
  group by h.symbol
),
chg as (
  select h.symbol,
         sum(h.quantity_change) filter (where d.rk <= 1) as chg_1d,
         sum(h.quantity_change) filter (where d.rk <= 5) as chg_5d,
         sum(h.quantity_change) filter (where d.rk <= 20) as chg_20d,
         count(distinct h.etf_symbol) filter (where d.rk <= 5 and h.quantity_change > 0) as n_buy_5d,
         count(distinct h.etf_symbol) filter (where d.rk <= 5 and h.quantity_change < 0) as n_sell_5d
  from public.etf_holdings_daily h
  join d on d.data_date = h.data_date
  where d.rk <= 20
  group by h.symbol
)
select symbol,
       (select max(data_date) from public.etf_holdings_daily) as as_of_date,
       coalesce(cur.n_etf, 0) as n_etf,
       coalesce(cur.qty, 0) as qty,
       coalesce(chg.chg_1d, 0) as chg_1d,
       coalesce(chg.chg_5d, 0) as chg_5d,
       coalesce(chg.chg_20d, 0) as chg_20d,
       coalesce(chg.n_buy_5d, 0) as n_buy_5d,
       coalesce(chg.n_sell_5d, 0) as n_sell_5d
from cur
full join chg using (symbol);

create or replace view public.v_tdcc_last_date as
select symbol, max(data_date) as last_date from public.tdcc_distribution_weekly group by symbol;

create or replace view public.v_etf_last_date as
select etf_symbol, max(data_date) as last_date from public.etf_holdings_daily group by etf_symbol;

revoke all on public.v_tdcc_latest, public.v_etf_active_flow, public.v_tdcc_last_date, public.v_etf_last_date from anon, authenticated;
grant select on public.v_tdcc_latest, public.v_etf_active_flow, public.v_tdcc_last_date, public.v_etf_last_date to service_role;
