import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = async (name) =>
  readFile(
    new URL(`../supabase/migrations/${name}.sql`, import.meta.url),
    "utf8",
  );

const cronHttpCall = `perform net.http_post(url := 'https://fixture.example/worker', headers := '{"Authorization":"Bearer fixture-token"}'::jsonb);`;
const createCronFixture = async (db) => {
  await db.exec(`create schema cron;
    create table cron.job(jobid bigint primary key,jobname text,schedule text,command text);
    create function cron.alter_job(job_id bigint,schedule text default null,command text default null)
    returns void language sql as $$
      update cron.job j set schedule=coalesce($2,j.schedule),command=coalesce($3,j.command) where j.jobid=$1;
    $$;
    create schema net;
    create table net.calls(url text,headers jsonb);
    create function net.http_post(url text,headers jsonb) returns bigint language plpgsql as $$
    begin insert into net.calls values($1,$2); return 1; end $$;`);
  await db.query(
    "insert into cron.job values(1,'check-price-alerts','*/10 1-5 * * 1-5',$1)",
    [`do $inner$ begin
      if exists (select 1 from public.alert_rules where enabled) then
        ${cronHttpCall}
      end if;
    end $inner$;`],
  );
};

test("migrations: split-adjusted scan, shared dates, provenance, atomic fills and delivery leases", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema vault;
      create table vault.decrypted_secrets(name text,decrypted_secret text);
      insert into vault.decrypted_secrets values('edge_function_auth','fixture-cron-secret');
      create table price_daily(symbol text,trade_date date,open numeric,high numeric,low numeric,close numeric,volume bigint,adj_factor numeric,primary key(symbol,trade_date));
      create table stock_industry(symbol text,stock_name text,industry_category text);
      create table industry_policy(industry text,excluded boolean);
      create table stock_institutional(symbol text,trade_date date,foreign_net bigint,primary key(symbol,trade_date));
      create table scan_picks(scan_date date,symbol text,name text,industry_category text,close numeric,score_total integer,score_surge integer,score_position integer,score_momentum integer,passes_all boolean,day_pct numeric,volume_lots numeric,frozen_at timestamptz default now(),primary key(scan_date,symbol));
      create table holdings_transactions(id uuid default gen_random_uuid(),symbol text,txn_type text,qty integer,price numeric,fee numeric,tax numeric,txn_date date,note text,signal_source text,signal_score numeric);
      create table quote_fixture(symbol text,current_price numeric,as_of_ts timestamptz,source text,market_state text);
      create view v_latest_price_realtime as select * from quote_fixture;`);
    await createCronFixture(db);
    // Verify CREATE OR REPLACE compatibility with the previous view shape.
    await db.exec(await migration("20260806000002_v_breakout_scan_scored"));
    for (const name of [
      "20260906000001_scan_adjusted",
      "20260906000002_scan_track_v2",
      "20260906000003_trade_plans",
      "20260906000006_plan_fill_lifecycle",
      "20260507000004_alerts",
      "20260906000004_alert_delivery",
    ])
      await db.exec(await migration(name));
    await db.exec("set role service_role");
    assert.equal(
      (await db.query("select read_edge_function_auth() secret")).rows[0].secret,
      "fixture-cron-secret",
    );
    await db.exec("reset role");
    for (const role of ["anon", "authenticated"])
      assert.equal(
        (await db.query("select has_function_privilege($1,'public.read_edge_function_auth()','execute') permitted", [role])).rows[0].permitted,
        false,
      );
    await db.exec(`insert into stock_industry values ('TEST','測試股','半導體業'),('MISS','缺料股','半導體業');
      insert into price_daily
      select s, current_date-40+i,case when i<25 then 100 else 50 end,
        case when i<25 then 102 else 51 end,case when i<25 then 98 else 49 end,
        case when i<25 then 100 else 50 end,6000000,case when i<25 then 0.5 else 1 end
      from generate_series(0,40) i cross join (values('TEST'),('MISS')) sy(s);
      insert into stock_institutional select 'TEST',current_date-i,100 from generate_series(0,4) i;
      insert into stock_institutional select 'MISS',current_date-i,100 from generate_series(1,5) i;`);
    let rows = (await db.query("select * from v_breakout_scan order by symbol"))
      .rows;
    const s = rows.find((r) => r.symbol === "TEST");
    assert.equal(Number(s.day_pct), 0);
    assert.equal(Number(s.ma20), 50);
    assert.equal(Number(s.high_20d), 51);
    assert.equal(Number(s.fgn_net_5d), 500);
    assert.equal(rows.find((r) => r.symbol === "MISS").fgn_net_5d, null);
    await db.exec(`insert into scan_picks(scan_date,symbol,close,score_total,frozen_at)
      values(current_date-30,'TEST',100,85,(current_date-30)::timestamptz);
      delete from price_daily where symbol='TEST' and trade_date=current_date-24;`);
    let obs = (await db.query("select * from v_scan_track_v2 where horizon=5"))
      .rows[0];
    assert.equal(obs.observation_status, "missing_price");
    assert.equal(obs.return_pct, null);
    assert.equal(obs.benchmark_return, null); // missing endpoint must not disappear from denominator
    await db.exec(
      `insert into price_daily values('TEST',current_date-24,100,102,98,100,6000000,0.5);`,
    );
    obs = (await db.query("select * from v_scan_track_v2 where horizon=20"))
      .rows[0];
    assert.equal(Number(obs.return_pct), 0); // spans split without a false -50% loss
    await db.exec(
      `update price_daily set close=54,high=55 where symbol='TEST' and trade_date=current_date;`,
    );
    const args = `'TEST',current_date,52,54,49,current_date+3,'突破後等待回測','跌破支撐即退出'`;
    const id = (await db.query(`select create_breakout_plan(${args}) as id`))
      .rows[0].id;
    await db.exec(
      `select record_plan_buy('${id}',1000,53,75,current_date,'依原計畫成交');`,
    );
    assert.equal(
      (await db.query("select status from trade_plans")).rows[0].status,
      "entered",
    );
    await assert.rejects(
      db.exec(
        `select record_plan_buy('${id}',1000,53,75,current_date,'重複');`,
      ),
    );
    assert.equal(
      (await db.query("select count(*)::int as n from holdings_transactions"))
        .rows[0].n,
      1,
    );
    const txnId = (await db.query("select id from holdings_transactions")).rows[0].id;
    await db.query("select delete_transaction_with_plan($1)", [txnId]);
    assert.equal((await db.query("select status from trade_plans")).rows[0].status, "watching");
    await db.exec(`select record_plan_buy('${id}',100,55,8,current_date,'修正誤填後重記');`);
    assert.equal((await db.query("select status from trade_plans")).rows[0].status, "entered");
    for (const role of ["anon", "authenticated"])
      assert.equal((await db.query("select has_function_privilege($1,'public.delete_transaction_with_plan(uuid)','execute') permitted", [role])).rows[0].permitted, false);
    await db.exec(`insert into alert_rules(symbol,condition,threshold,enabled) values('TEST','price_above',50,false);
      insert into alert_events(rule_id,symbol,snapshot) values(1,'TEST','{"delivery_version":2}');`);
    const token = "11111111-1111-4111-8111-111111111111";
    assert.equal(
      (await db.query(`select * from claim_price_alerts('${token}')`)).rows
        .length,
      1,
    );
    assert.equal(
      (await db.query(`select * from claim_price_alerts('${token}')`)).rows
        .length,
      0,
    );
    await db.exec(
      `update alert_events set delivery_after=now()-interval '1 minute';`,
    );
    assert.equal(
      (await db.query(`select * from claim_price_alerts('${token}')`)).rows
        .length,
      1,
    );
    assert.equal(
      (await db.query("select notified from alert_events")).rows[0].notified,
      false,
    );
    await db.exec(
      `update alert_events set notified=true,delivery_after=now()-interval '1 minute';`,
    );
    assert.equal(
      (await db.query(`select * from claim_price_alerts('${token}')`)).rows
        .length,
      0,
    );
    // Freeze the database clock only in this isolated fixture to exercise a
    // regular trading session even when tests run on weekends.
    const alertSql = await migration("20260906000004_alert_delivery");
    await db.exec(
      alertSql
        .slice(
          alertSql.indexOf("create or replace function public.claim_price_alerts"),
          alertSql.indexOf("revoke all on function public.claim_price_alerts"),
        )
        .replaceAll("now()", "timestamptz '2026-09-07T02:00:00Z'"),
    );
    await db.exec(`insert into alert_rules(symbol,condition,threshold) values('FRESH','price_above',50),('STALE','price_above',50),('DAILY','price_above',50);
      insert into quote_fixture values
      ('FRESH',54,'2026-09-07T01:58:00Z','twse_mis','REGULAR'),
      ('STALE',54,'2026-09-07T01:00:00Z','twse_mis','REGULAR'),
      ('DAILY',54,'2026-09-07T01:58:00Z','twse_today',null);`);
    const fresh = (
      await db.query(`select * from claim_price_alerts('${token}')`)
    ).rows;
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].symbol, "FRESH");
    assert.equal(fresh[0].notified, false);
    assert.equal(
      (await db.query(`select * from claim_price_alerts('${token}')`)).rows
        .length,
      0,
    );
    assert.equal(
      (await db.query(`select count(*)::int n from alert_rules where enabled`))
        .rows[0].n,
      2,
    );
  } finally {
    await db.close();
  }
});

test("alert cron retries due deliveries after the last rule is disabled and rejects unknown commands", async () => {
  const db = new PGlite();
  try {
    await createCronFixture(db);
    await db.exec(`create table alert_rules(enabled boolean);
      create table alert_events(notified boolean,delivery_after timestamptz,snapshot jsonb);
      insert into alert_rules values(false);`);
    const alertSql = await migration("20260906000004_alert_delivery");
    const cronMigration = alertSql.slice(alertSql.indexOf("-- The existing cron"));
    await db.exec(cronMigration);
    const job = (await db.query("select * from cron.job")).rows[0];
    assert.equal(job.schedule, "*/10 * * * *");
    assert.ok(job.command.includes(cronHttpCall)); // preserve the exact URL/auth invocation
    const runCron = async () => {
      await db.exec("truncate net.calls");
      await db.exec(job.command);
      return (await db.query("select count(*)::int n from net.calls")).rows[0].n;
    };
    assert.equal(await runCron(), 0); // disabled rules and no pending work
    await db.exec(`insert into alert_events values(false,now()-interval '1 minute','{"delivery_version":2}');`);
    assert.equal(await runCron(), 1); // final rule is disabled, but delivery must retry
    await db.exec("update alert_events set delivery_after=now()+interval '10 minutes'");
    assert.equal(await runCron(), 0); // an active delivery lease must not spin the worker
    await db.exec("update alert_events set notified=true,delivery_after=now()-interval '1 minute'");
    assert.equal(await runCron(), 0);
    await db.exec(`update alert_events set notified=false,snapshot='{}'`);
    assert.equal(await runCron(), 0); // legacy events are intentionally not replayed
    await db.exec("update alert_rules set enabled=true");
    assert.equal(await runCron(), 1);
    await db.exec("update cron.job set command='select 1'");
    await assert.rejects(db.exec(cronMigration), /cron command is unexpected/);
    await db.exec("delete from cron.job");
    await assert.rejects(db.exec(cronMigration), /cron job is missing/);
  } finally {
    await db.close();
  }
});
