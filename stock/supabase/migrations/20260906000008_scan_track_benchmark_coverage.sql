-- The previous benchmark gate (bool_and over every pool member) was unreachable:
-- across 60 measured anchors NOT ONE reached 100% coverage, because ~15-30 of the
-- ~1750 pool names are suspended or unpriced in any given window. The benchmark
-- was therefore permanently null, excess_pct was permanently null, and no sample
-- could ever reach 'settled' -- the strategy-evidence panel would have stayed
-- empty forever regardless of how much data accumulated.
--
-- Replace it with a 95% coverage floor. Missing names skew towards losers, so the
-- floor still bounds survivorship bias: at <=5% missing, even a -50% outcome for
-- every missing name moves the benchmark by at most ~2.5pp, and bench_n /
-- bench_observed_n stay exposed so the actual coverage is always auditable.
-- Only the benchmark CTE changes; scoring, anchors, freezing and the column list
-- are untouched. Roll back by re-applying 20260906000002_scan_track_v2.sql.
create or replace view public.v_scan_track_v2 as
with days as (
  select trade_date, row_number() over (order by trade_date) as dn
  from (select distinct trade_date from public.price_daily
        where trade_date >= (select min(scan_date) from public.scan_picks)) d
), anchors as (
  select s.scan_date, h.horizon, en.trade_date as entry_date, ex.trade_date as exit_date
  from (select distinct scan_date from public.scan_picks) s
  cross join (values (5), (10), (20)) h(horizon)
  join days d on d.trade_date = s.scan_date
  left join days en on en.dn = d.dn + 1
  left join days ex on ex.dn = d.dn + 1 + h.horizon
), benchmark as (
  select a.scan_date, a.horizon, count(*) as bench_n,
    count(*) filter (where en.close > 0 and en.adj_factor > 0
      and ex.close > 0 and ex.adj_factor > 0) as bench_observed_n,
    -- Require 95% of the pool to be priced at BOTH ends, then average only the
    -- priced names. Below the floor the benchmark stays null rather than
    -- quietly comparing against whichever names happened to survive.
    case when count(*) > 0
      and count(*) filter (where en.close > 0 and en.adj_factor > 0
        and ex.close > 0 and ex.adj_factor > 0) >= 0.95 * count(*)
    then
      100 * avg(ex.close * ex.adj_factor / nullif(en.close * en.adj_factor, 0) - 1)
        filter (where en.close > 0 and en.adj_factor > 0
          and ex.close > 0 and ex.adj_factor > 0)
    end as benchmark_return
  from anchors a
  join public.price_daily pool on pool.trade_date = a.scan_date and pool.close >= 20
  left join public.price_daily en on en.symbol = pool.symbol and en.trade_date = a.entry_date
  left join public.price_daily ex on ex.symbol = pool.symbol and ex.trade_date = a.exit_date
  group by a.scan_date, a.horizon
), measured as (
  select p.scan_date, p.symbol, p.score_total, p.passes_all, p.strategy_version,
    a.horizon, a.entry_date, a.exit_date,
    p.frozen_at < (a.entry_date + time '13:30') at time zone 'Asia/Taipei' as frozen_before_entry,
    case when en.close > 0 and en.adj_factor > 0 and ex.close > 0 and ex.adj_factor > 0
      then 100 * (ex.close * ex.adj_factor / (en.close * en.adj_factor) - 1)
    end as return_pct,
    bm.benchmark_return, bm.bench_n, bm.bench_observed_n
  from public.scan_picks p
  join anchors a on a.scan_date = p.scan_date
  left join public.price_daily en on en.symbol = p.symbol and en.trade_date = a.entry_date
  left join public.price_daily ex on ex.symbol = p.symbol and ex.trade_date = a.exit_date
  left join benchmark bm on bm.scan_date = p.scan_date and bm.horizon = a.horizon
)
select *,
  case when frozen_before_entry then return_pct - benchmark_return end as excess_pct,
  case when entry_date is null or exit_date is null then 'pending'
       when not frozen_before_entry then 'late_snapshot'
       when return_pct is null then 'missing_price'
       when benchmark_return is null then 'missing_benchmark'
       else 'settled' end as observation_status
from measured;

revoke all on public.v_scan_track_v2 from anon, authenticated;
grant select on public.v_scan_track_v2 to service_role;
comment on view public.v_scan_track_v2 is
  'Adjusted close-to-close observations on shared MARKET dates. Benchmark requires 95% of the priced pool at both ends (bench_observed_n / bench_n shows actual coverage); below that it is suppressed. Late snapshots excluded. Uncosted, not executable strategy returns.';
