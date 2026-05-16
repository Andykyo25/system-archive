-- 前向紙上追蹤 + universe 快照(2026-05-16)
--
-- 目的:把「研究級回測(受不可測倖存者偏差)」升級成「真前向 OOS 證據」。
--   每 ~20 交易日凍結當下 v_stock_rank top10(名單當下定死 = 零倖存者偏差)
--   + 0050 benchmark,20 交易日後用 adj_close 結算,累積真實時間序列。
--   universe_snapshot:每週凍結成員,給日後 point-in-time de-bias 用(L38)。
--
-- 設計:純 pg_cron + plpgsql,不開 EF(最少移動件)。零策略改動、純加法。
--   進出場用 close*adj_factor(與 honest-v2 回測一致,除權息中性)。
--   成本沿用 ETF 差別公式(對齊 holdings/honest-v2,^00\d 判定)。
--   入場 = 決策日 close(與 v2 nextopen 差一日,屬二階;凍結名單才是抗
--   倖存者關鍵,先求簡單可長跑,日後要對齊再說)。

create table if not exists public.universe_snapshot (
  snapshot_date date not null,
  symbol        text not null,
  primary key (snapshot_date, symbol)
);
comment on table public.universe_snapshot is
  'L38 de-bias 前置:每週凍結 universe 成員,日後 backtest 可 point-in-time。';

create table if not exists public.paper_picks (
  id            bigint generated always as identity primary key,
  cohort_date   date    not null,
  rank          int,                       -- null = benchmark
  symbol        text    not null,
  is_benchmark  boolean not null default false,
  weighted_score numeric,
  entry_date    date    not null,
  entry_px      numeric not null,          -- close*adj_factor @ cohort_date
  period_days   int     not null default 20,
  exit_date     date,
  exit_px       numeric,
  status        text    not null default 'open',  -- open | settled
  created_at    timestamptz not null default now()
);
create index if not exists idx_paper_picks_cohort on public.paper_picks (cohort_date, status);
comment on table public.paper_picks is
  '前向紙上追蹤:每 cohort 凍結 v_stock_rank top_n(rank 存著可拆 top5/10)+ 0050。';

-- ===== tick:universe 快照 + 結算到期 cohort + 到期開新 cohort =====
create or replace function public.paper_track_tick(
  p_top_n int default 10,
  p_period int default 20
) returns text
language plpgsql
as $$
declare
  v_last_cohort date;
  v_open_exists boolean;
  v_tdays_since int;
  v_opened int := 0;
  v_settled int := 0;
  v_msg text;
begin
  -- 1) universe 週快照(idempotent)
  insert into public.universe_snapshot (snapshot_date, symbol)
  select current_date, symbol from (
    select symbol from public.stock_universe
    union select symbol from public.industry_stocks
    union select symbol from public.watchlist
    union select symbol from public.holdings_transactions
    union select symbol from public.etf_metadata
  ) u
  on conflict do nothing;

  -- 2) 結算:open cohort 滿 p_period 交易日 → 填 exit
  with oc as (select distinct cohort_date from public.paper_picks where status = 'open'),
  mat as (
    select oc.cohort_date,
      (select d from (
         select distinct trade_date d from public.price_daily
         where trade_date > oc.cohort_date order by trade_date
       ) z offset (p_period - 1) limit 1) as exit_d
    from oc
  )
  update public.paper_picks pp
  set exit_date = m.exit_d,
      exit_px = (
        select pd.close * pd.adj_factor from public.price_daily pd
        where pd.symbol = pp.symbol and pd.trade_date <= m.exit_d
        order by pd.trade_date desc limit 1
      ),
      status = 'settled'
  from mat m
  where pp.cohort_date = m.cohort_date and pp.status = 'open' and m.exit_d is not null;
  get diagnostics v_settled = row_count;

  -- 3) 開新 cohort:無 open cohort 且(沒任何 cohort 或距上次 >= p_period 交易日)
  select max(cohort_date) into v_last_cohort from public.paper_picks;
  select exists(select 1 from public.paper_picks where status = 'open') into v_open_exists;
  if v_last_cohort is null then
    v_tdays_since := p_period;  -- 第一次:立刻開,啟動時鐘
  else
    select count(*) into v_tdays_since from (
      select distinct trade_date from public.price_daily
      where trade_date > v_last_cohort and trade_date <= current_date
    ) z;
  end if;

  if not v_open_exists and v_tdays_since >= p_period then
    -- 策略 top_n
    insert into public.paper_picks
      (cohort_date, rank, symbol, is_benchmark, weighted_score, entry_date, entry_px, period_days, status)
    select current_date, r.expected_rank, r.symbol, false, r.weighted_score, current_date,
      (select pd.close * pd.adj_factor from public.price_daily pd
       where pd.symbol = r.symbol and pd.trade_date <= current_date
       order by pd.trade_date desc limit 1),
      p_period, 'open'
    from public.v_stock_rank r
    where r.expected_rank <= p_top_n
      and exists (select 1 from public.price_daily pd where pd.symbol = r.symbol);
    get diagnostics v_opened = row_count;
    -- benchmark 0050
    insert into public.paper_picks
      (cohort_date, rank, symbol, is_benchmark, weighted_score, entry_date, entry_px, period_days, status)
    select current_date, null, '0050', true, null, current_date,
      (select pd.close * pd.adj_factor from public.price_daily pd
       where pd.symbol = '0050' and pd.trade_date <= current_date
       order by pd.trade_date desc limit 1),
      p_period, 'open'
    where exists (select 1 from public.price_daily where symbol = '0050');
  end if;

  v_msg := format('paper_track_tick: settled=%s opened=%s tdays_since_last=%s last_cohort=%s',
    v_settled, v_opened, v_tdays_since, coalesce(v_last_cohort::text, 'none'));
  insert into public.fetch_log (source, success, rows_written, finished_at, error)
  values ('paper_track', true, v_settled + v_opened, now(), v_msg);
  return v_msg;
end;
$$;

revoke execute on function public.paper_track_tick(int, int) from public, anon, authenticated;
grant execute on function public.paper_track_tick(int, int) to service_role;

-- ===== 績效 view:每 cohort 的 top5/top10 淨 alpha(扣 ETF 差別成本)=====
create or replace view public.v_paper_performance as
with s as (
  select
    coalesce((select value from public.app_settings where key='commission_base_rate'),0.001425::numeric) cbr,
    coalesce((select value from public.app_settings where key='commission_discount'),1::numeric) cd,
    coalesce((select value from public.app_settings where key='sell_tax_stock'),0.003::numeric) ts,
    coalesce((select value from public.app_settings where key='sell_tax_etf'),0.001::numeric) te
),
pp as (
  select p.*,
    case when p.is_benchmark then 0::numeric
      else (select cbr*cd*2 + case when p.symbol ~ '^00\d' then te else ts end from s)
    end as cost_frac
  from public.paper_picks p
  where p.status = 'settled' and p.entry_px > 0 and p.exit_px is not null
),
r as (
  select cohort_date, is_benchmark, rank,
    (exit_px - entry_px) / entry_px - cost_frac as net_ret
  from pp
)
select
  cohort_date,
  count(*) filter (where not is_benchmark) as n_picks,
  round(avg(net_ret) filter (where not is_benchmark) * 100, 2) as strat_all_ret_pct,
  round(avg(net_ret) filter (where not is_benchmark and rank <= 5) * 100, 2) as strat_top5_ret_pct,
  round(max(net_ret) filter (where is_benchmark) * 100, 2) as bench0050_ret_pct,
  round((avg(net_ret) filter (where not is_benchmark and rank <= 5)
         - max(net_ret) filter (where is_benchmark)) * 100, 2) as alpha_top5_pct,
  round((avg(net_ret) filter (where not is_benchmark)
         - max(net_ret) filter (where is_benchmark)) * 100, 2) as alpha_all_pct
from r
group by cohort_date
order by cohort_date;
comment on view public.v_paper_performance is
  '前向紙上追蹤績效:每 cohort top5/全體 淨報酬 vs 0050(扣 ETF 差別成本)。
   零倖存者偏差(名單決策當下凍結)。累積多 cohort 才有統計意義。';

-- ===== cron:每週六 22:00 UTC = 週日 06:00 Taipei(避開既有排程)=====
select cron.unschedule(jobid) from cron.job where jobname = 'paper-track-weekly';
select cron.schedule(
  'paper-track-weekly',
  '0 22 * * 6',
  $cron$ select public.paper_track_tick() $cron$
);
