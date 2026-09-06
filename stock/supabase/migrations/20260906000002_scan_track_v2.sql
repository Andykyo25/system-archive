-- Read-only mark-to-market observation, NOT an execution backtest. No costs deducted.
-- Keep v_scan_track intact so old reports remain reproducible.
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
    -- Do not silently drop suspended/missing losers from the benchmark.
    case when bool_and(coalesce(en.close > 0 and en.adj_factor > 0
      and ex.close > 0 and ex.adj_factor > 0, false)) then
      100 * avg(ex.close * ex.adj_factor / nullif(en.close * en.adj_factor, 0) - 1)
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
  'Adjusted close-to-close observations on shared MARKET dates. Incomplete benchmark suppressed; late snapshots excluded. Uncosted, not executable strategy returns.';
