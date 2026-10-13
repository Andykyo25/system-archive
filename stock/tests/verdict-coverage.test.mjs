import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { factorCell } from "../lib/scan.ts";

test("verdict card: collecting, no source data and evaluated counts are distinct states", () => {
  assert.equal(factorCell(false, null, null), "收料中");
  assert.equal(factorCell(true, 0, 0), "無可評資料");
  assert.equal(factorCell(true, null, 3), "無可評資料");
  assert.equal(factorCell(true, 0, 3), "0/3 通過");
  assert.equal(factorCell(true, 7, 7), "7/7 通過");
});

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const migrationA = () => read("../supabase/migrations/20261013000001_verdict_factor_coverage.sql");
const migrationB = () => read("../supabase/migrations/20261013000002_verdict_backfill.sql");
const migrationE = () => read("../supabase/migrations/20261013000005_verdict_backfill_freshness.sql");
const migrationC = () => read("../supabase/migrations/20261013000003_chip_universe_skip_etf.sql");
const rollback = () => read("../tasks/rollback-20261013.sql");

// Fixture views keep the production shapes the migration rewrites: the same CTE names,
// the same universe sources and the same expected_rank / select tail.
const fixtureA = `
create role anon; create role authenticated; create role service_role;
create schema cron;
create table cron.job(jobid bigserial primary key, jobname text unique, schedule text, command text);
create function cron.unschedule(job_name text) returns boolean language sql as $$
  delete from cron.job where jobname = $1 returning true $$;
create table stock_universe(symbol text); create table industry_stocks(symbol text);
create table watchlist(symbol text); create table holdings_transactions(symbol text);
create table etf_metadata(symbol text); create table day_trades(symbol text);
create table universe_dynamic(symbol text primary key, active boolean not null default true);
create table collection_candidates(symbol text primary key, signal_date date not null);
create table price_daily(symbol text, trade_date date, close numeric, primary key(symbol, trade_date));
create table chip_rows(symbol text, n int);
create view v_fetch_universe as select symbol from stock_universe;
create view v_price_factors as
  with universe_symbols as (
    select symbol from stock_universe union select symbol from industry_stocks
    union select symbol from watchlist union select symbol from holdings_transactions
    union select symbol from etf_metadata union select symbol from universe_dynamic where active
  ), ranked as (
    select p.symbol, p.close from price_daily p join universe_symbols u on u.symbol = p.symbol
  )
  select symbol, max(close) as latest_close from ranked group by symbol;
create view v_chip_factors as
  with universe_symbols as (
    select symbol from stock_universe union select symbol from industry_stocks
    union select symbol from watchlist union select symbol from holdings_transactions
  ), inst_recent as (
    select c.symbol, c.n from chip_rows c join universe_symbols u on u.symbol = c.symbol
  )
  select u.symbol, i.n as chip_count_total from universe_symbols u left join inst_recent i on i.symbol = u.symbol;
create table factor_src(symbol text primary key, weighted_score numeric, fund_count_total int, mom_strong_persist boolean);
create materialized view mv_factor_scores as select * from factor_src;
create unique index on mv_factor_scores(symbol);
create view v_stock_rank as
  with scored as (select * from mv_factor_scores)
  select symbol, weighted_score,
    row_number() over (order by (fund_count_total > 0) desc, weighted_score desc nulls last, symbol) as expected_rank,
    fund_count_total, mom_strong_persist
  from scored s;
create table r2p_out(symbol text, dims jsonb);
create function freeze_r2p_forward() returns boolean language plpgsql security definer set search_path to 'public' as $f$
begin
  insert into r2p_out select v.symbol, (select to_jsonb(r) from public.v_stock_rank r where r.symbol=v.symbol) from collection_candidates v;
  return found;
end $f$;
create function cleanup_market_prices() returns integer language sql as $f$
  with del as (
    delete from public.price_daily p
    where p.trade_date < current_date - 135
      and not exists (select 1 from public.v_fetch_universe u where u.symbol = p.symbol)
      and not exists (select 1 from public.universe_dynamic ud where ud.symbol = p.symbol)
      and not exists (select 1 from public.holdings_transactions t where t.symbol = p.symbol)
      and not exists (select 1 from public.day_trades dt where dt.symbol = p.symbol)
    returning 1
  )
  select count(*)::int from del;
$f$;
insert into stock_universe values ('2330'), ('2317');
insert into etf_metadata values ('0050'), ('0056'), ('00999');
insert into holdings_transactions values ('0056');
insert into universe_dynamic values ('3605', true), ('1111', false);
insert into chip_rows values ('2330', 5), ('3605', 4), ('0050', 1), ('6924', 3), ('1111', 2);
insert into factor_src values ('2330', 80, 7, true), ('2317', 70, 7, false), ('0050', 75, 0, true), ('3605', 60, 7, true);
refresh materialized view mv_factor_scores;
insert into price_daily values ('2330', current_date, 1000), ('3605', current_date, 179), ('6924', current_date, 146),
  ('9999', current_date, 10), ('7777', current_date - 150, 5), ('7777', current_date - 250, 5), ('6924', current_date - 250, 99);
`;

const defs = async (db) =>
  (await db.query(`select
    pg_get_viewdef('v_price_factors'::regclass, true) pf, pg_get_viewdef('v_chip_factors'::regclass, true) cf,
    pg_get_viewdef('v_stock_rank'::regclass, true) sr,
    pg_get_functiondef('freeze_r2p_forward()'::regprocedure) fz,
    pg_get_functiondef('cleanup_market_prices()'::regprocedure) cl`)).rows[0];
const symbols = async (db, sql) => (await db.query(sql)).rows.map((r) => r.symbol);

test("verdict coverage: candidates get factors, rank stays neutral, chip universe aligns and rollback restores", async () => {
  const db = new PGlite();
  try {
    await db.exec(fixtureA);
    const before = await defs(db);
    const rankBefore = (await db.query("select symbol, expected_rank from v_stock_rank order by symbol")).rows;

    await db.exec(await migrationA());
    await db.exec(await migrationC());
    // Candidate inside the 7-day window, one outside it, and the hot pool entering the chip universe.
    await db.exec(`insert into collection_candidates values ('6924', current_date - 1), ('9999', current_date - 10);
      insert into factor_src values ('6924', 99, 7, true), ('9999', 95, 7, true);
      refresh materialized view concurrently mv_factor_scores;`);

    assert.deepEqual(await symbols(db, "select symbol from v_price_factors order by symbol"), ["2330", "3605", "6924"]);
    // Pure ETFs (no chip collection, some delisted with no price) stay out; a held ETF keeps its row as before.
    assert.deepEqual(await symbols(db, "select symbol from v_chip_factors order by symbol"), ["0056", "2317", "2330", "3605", "6924"]);

    // D1: v_stock_rank is exactly the old ranking; candidates and stale rows only live in v_stock_rank_all.
    assert.deepEqual((await db.query("select symbol, expected_rank from v_stock_rank order by symbol")).rows, rankBefore);
    const all = (await db.query("select symbol, expected_rank, rank_eligible from v_stock_rank_all order by expected_rank")).rows;
    assert.deepEqual(all.map((r) => [r.symbol, r.rank_eligible]), [
      ["2330", true], ["2317", true], ["3605", true], ["0050", true], ["6924", false], ["9999", false],
    ]);
    assert.deepEqual(
      (await db.query("select column_name from information_schema.columns where table_name='v_stock_rank' order by ordinal_position")).rows.map((r) => r.column_name),
      ["symbol", "weighted_score", "expected_rank", "fund_count_total", "mom_strong_persist"],
    );

    // Forward ledger records candidate dimensions; cleanup keeps 120+ bars and every candidate's history.
    await db.exec("select freeze_r2p_forward()");
    const dims = (await db.query("select dims from r2p_out where symbol='6924'")).rows[0].dims;
    assert.equal(dims.rank_eligible, false);
    assert.equal(dims.expected_rank, 5);
    assert.equal((await db.query("select cleanup_market_prices() n")).rows[0].n, 1);
    assert.deepEqual((await db.query("select symbol, current_date - trade_date age from price_daily where trade_date < current_date - 100 order by symbol")).rows,
      [{ symbol: "6924", age: 250 }, { symbol: "7777", age: 150 }]);

    // Idempotent re-run leaves every definition untouched and keeps the original snapshot.
    const after = await defs(db);
    await db.exec(await migrationA());
    await db.exec(await migrationC());
    assert.deepEqual(await defs(db), after);
    assert.equal((await db.query("select definition from schema_rollback_snapshots where object_name='v_stock_rank'")).rows[0].definition, before.sr);
    assert.equal((await db.query("select has_table_privilege('anon','v_factor_universe','select') ok")).rows[0].ok, false);
    assert.equal((await db.query("select has_table_privilege('anon','v_stock_rank_all','select') ok")).rows[0].ok, true);

    await db.exec(await rollback());
    assert.deepEqual(await defs(db), before);
    assert.equal((await db.query("select to_regclass('v_stock_rank_all') is null and to_regclass('v_factor_universe') is null and to_regclass('v_rank_universe') is null ok")).rows[0].ok, true);
  } finally {
    await db.close();
  }
});

test("verdict coverage: aborts instead of guessing when the audited universe changed", async () => {
  const db = new PGlite();
  try {
    await db.exec(fixtureA.replace(
      "select symbol from stock_universe union select symbol from industry_stocks\n    union select symbol from watchlist union select symbol from holdings_transactions\n  ), inst_recent",
      "select symbol from stock_universe union select symbol from industry_stocks\n    union select symbol from watchlist union select symbol from holdings_transactions union select symbol from etf_metadata\n  ), inst_recent",
    ));
    await assert.rejects(db.exec(await migrationA()), /v_chip_factors: universe differs/);
    assert.equal((await db.query("select to_regclass('v_stock_rank_all') is null ok")).rows[0].ok, true);
  } finally {
    await db.close();
  }
});

const fixtureB = `
create role anon; create role authenticated; create role service_role;
create schema cron;
create table cron.job(jobid bigserial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job(jobname, schedule, command) values ($1, $2, $3)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create schema net;
create table net.calls(url text, headers jsonb, body jsonb);
create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) returns bigint language plpgsql as $$
begin insert into net.calls values (url, headers, body); return 1; end $$;
create function read_edge_function_auth() returns text language sql as $$ select 'fixture-token' $$;
create table holdings(symbol text); create view v_holdings_current as select * from holdings;
create table watchlist(symbol text); create table industry_stocks(symbol text); create table stock_universe(symbol text);
create table etf_metadata(symbol text); create view v_fetch_universe_stocks as select symbol from holdings;
create table api_quota_state(source text, quota_date date, used int, budget int, primary key(source, quota_date));
create table scan_fixture(symbol text, trade_date date, score_total int, day_pct numeric);
create view v_scan_verdict as select * from scan_fixture;
create table price_daily(symbol text, trade_date date, close numeric, primary key(symbol, trade_date));
create table stock_fundamentals_quarterly(symbol text, period_end date);
create table stock_monthly_revenue(symbol text, period_year int, period_month int);
create table stock_pe_pb_daily(symbol text, trade_date date);
create table stock_institutional(symbol text, trade_date date);
create table stock_margin(symbol text, trade_date date);
create table lending_rows(symbol text, trade_date date);
create view v_securities_lending_daily as select symbol, trade_date from lending_rows;
create table stock_shareholding(symbol text, report_date date);
create function tpe() returns date language sql as $$ select (now() at time zone 'Asia/Taipei')::date $$;
-- 21 trading days for the coverage baseline; the latest day starts half-collected.
insert into price_daily select s, tpe() - g, 10 from generate_series(1, 20) g, unnest(array['0050','X1','X2','X3','X4','X5','X6','X7','X8','X9']) s;
insert into price_daily select s, tpe(), 10 from unnest(array['0050','X1','X2','X3']) s;
insert into scan_fixture values ('AAAA', tpe(), 90, 9.8), ('BBBB', tpe(), 85, 7.0), ('CCCC', tpe(), 84, 6.0);
-- BBBB already has everything the factors need; AAAA has nothing but today's close.
insert into price_daily select 'BBBB', tpe() - g, 10 from generate_series(0, 210) g;
insert into price_daily values ('AAAA', tpe(), 10);
insert into stock_fundamentals_quarterly select 'BBBB', (date_trunc('quarter', tpe()) - (g * interval '3 months') - interval '1 day')::date from generate_series(1, 8) g;
insert into stock_monthly_revenue select 'BBBB', extract(year from m)::int, extract(month from m)::int
  from generate_series(date_trunc('month', tpe()) - interval '13 months', date_trunc('month', tpe()) - interval '1 month', interval '1 month') m;
insert into stock_pe_pb_daily values ('BBBB', tpe() - 1);
insert into stock_institutional select 'BBBB', tpe() - g from generate_series(1, 3) g;
insert into stock_margin select 'BBBB', tpe() - g from generate_series(1, 3) g;
insert into lending_rows select 'BBBB', tpe() - g from generate_series(1, 2) g;
insert into stock_shareholding select 'BBBB', tpe() - g * 7 from generate_series(1, 2) g;
-- CCCC = BBBB, except institutional stopped two days early (like a stock evicted from the hot pool):
-- still 3 rows in 14 days, but older than the market's latest institutional date.
insert into price_daily select 'CCCC', trade_date, close from price_daily where symbol = 'BBBB';
insert into stock_fundamentals_quarterly(symbol, period_end) select 'CCCC', period_end from stock_fundamentals_quarterly where symbol = 'BBBB';
insert into stock_monthly_revenue select 'CCCC', period_year, period_month from stock_monthly_revenue where symbol = 'BBBB';
insert into stock_pe_pb_daily select 'CCCC', trade_date from stock_pe_pb_daily where symbol = 'BBBB';
insert into stock_institutional select 'CCCC', tpe() - g from generate_series(3, 5) g;
insert into stock_margin select 'CCCC', trade_date from stock_margin where symbol = 'BBBB';
insert into lending_rows select 'CCCC', trade_date from lending_rows where symbol = 'BBBB';
insert into stock_shareholding select 'CCCC', report_date from stock_shareholding where symbol = 'BBBB';
`;

test("verdict backfill: waits for a complete close, requests only missing datasets once, restricted", async () => {
  const db = new PGlite();
  try {
    await db.exec(fixtureB);
    await db.exec(await read("../supabase/migrations/20261008075201_collection_priority.sql"));
    await db.exec(await migrationB());
    await db.exec(await migrationE());

    assert.equal((await db.query("select request_verdict_backfill() n")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from net.calls")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from collection_candidates")).rows[0].n, 0);

    await db.exec("insert into price_daily select s, tpe(), 10 from unnest(array['X4','X5','X6','X7','X8','X9']) s");
    // AAAA misses all 8 datasets; CCCC only has stale institutional; BBBB is complete and current.
    assert.equal((await db.query("select request_verdict_backfill() n")).rows[0].n, 9);
    assert.deepEqual(await symbols(db, "select symbol from collection_candidates order by symbol"), ["AAAA", "BBBB", "CCCC"]);
    const calls = (await db.query("select body from net.calls order by body->>'dataset'")).rows.map((r) => r.body);
    assert.deepEqual(calls.map((b) => b.dataset),
      ["fundamentals", "institutional", "lending", "margin", "monthly_revenue", "price", "shareholding", "valuation"]);
    for (const b of calls) {
      assert.deepEqual(b.symbols, b.dataset === "institutional" ? ["AAAA", "CCCC"] : ["AAAA"]);
      assert.equal(b.token_key, "finmind_token_2");
    }
    const today = (await db.query("select tpe()::text d")).rows[0].d;
    const start = Object.fromEntries((await db.query(
      "select dataset, start_date::text s from verdict_backfill_requests where symbol='AAAA'")).rows.map((r) => [r.dataset, r.s]));
    assert.equal(start.institutional, (await db.query("select (tpe() - 30)::text d")).rows[0].d);
    assert.equal(start.shareholding, (await db.query("select (tpe() - 60)::text d")).rows[0].d);
    assert.equal(start.price, (await db.query("select (tpe() - interval '3 years')::date::text d")).rows[0].d);
    assert.ok(calls.every((b) => b.end_date === today));

    // Within the cooldown nothing is re-requested.
    assert.equal((await db.query("select request_verdict_backfill() n")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from net.calls")).rows[0].n, 8);
    // Three hours later only still-missing daily datasets retry (chips publish ~17:00); slow ones wait 7 days.
    await db.exec("update verdict_backfill_requests set requested_at = requested_at - interval '4 hours'");
    assert.equal((await db.query("select request_verdict_backfill() n")).rows[0].n, 6);
    assert.deepEqual((await db.query("select body->>'dataset' d from net.calls offset 8")).rows.map((r) => r.d).sort(),
      ["institutional", "lending", "margin", "shareholding", "valuation"]);

    assert.deepEqual((await db.query("select schedule from cron.job where jobname='request-verdict-backfill'")).rows, [{ schedule: "40 6,7,8,9,14 * * 1-5" }]);
    assert.equal((await db.query("select has_function_privilege('anon','request_verdict_backfill()','execute') ok")).rows[0].ok, false);
    assert.equal((await db.query("select has_table_privilege('anon','verdict_backfill_requests','select') ok")).rows[0].ok, false);
  } finally {
    await db.close();
  }
});

test("R2p supply share uses the validated 90 bars, other callers keep 120", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create table price_daily(symbol text, trade_date date, close numeric, volume bigint, primary key(symbol, trade_date));
      create function scan_supply_share(p_symbol text, p_date date, p_price numeric) returns numeric language sql stable as $$
        select round(coalesce(sum(volume) filter (where close > p_price and close <= p_price * 1.2), 0)::numeric / nullif(sum(volume), 0), 3)
        from (select close, volume from public.price_daily where symbol = p_symbol and trade_date <= p_date order by trade_date desc limit 120) d $$;
      create function cleanup_market_prices() returns integer language sql as $$ select 0 $$;
      create table base_fixture(symbol text, trade_date date, close numeric);
      create view v_scan_verdict as
        with b as (select * from base_fixture),
        c as (select b.symbol, b.trade_date, b.close, scan_supply_share(b.symbol, b.trade_date, b.close) as supply_share from b)
        select * from c where supply_share <= 0.10;
      create materialized view mv_scan_verdict as select * from v_scan_verdict;
      create unique index on mv_scan_verdict(symbol);
      -- latest 90 bars below the price, bars 91-120 inside (p, 1.2p]: 90 bars = 0, 120 bars = 0.25
      insert into price_daily select 'S', current_date - g, case when g < 90 then 90 else 110 end, 1000 from generate_series(0, 119) g;
      update price_daily set close = 100 where trade_date = current_date;
      insert into base_fixture values ('S', current_date, 100);
      refresh materialized view mv_scan_verdict;`);
    assert.equal((await db.query("select count(*)::int n from mv_scan_verdict")).rows[0].n, 0);
    await db.exec(await read("../supabase/migrations/20261013000007_r2p_supply_90_bars.sql"));
    assert.deepEqual((await db.query("select symbol, supply_share::float s from mv_scan_verdict")).rows, [{ symbol: "S", s: 0 }]);
    assert.equal((await db.query("select scan_supply_share('S', current_date, 100)::float s")).rows[0].s, 0.25);
    await db.exec(await read("../supabase/migrations/20261013000007_r2p_supply_90_bars.sql"));
  } finally {
    await db.close();
  }
});
