import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { estimateRisk } from "../lib/plan-risk.ts";

const migration = await readFile(
  new URL("../supabase/migrations/20260906000005_plan_risk.sql", import.meta.url),
  "utf8",
);

async function fixture() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table app_settings(key text primary key,value numeric);
    create table price_daily(symbol text,trade_date date,close numeric,primary key(symbol,trade_date));
    create table stock_industry(symbol text primary key,industry_category text);
    create table holdings_transactions(symbol text,txn_type text,qty integer,price numeric,fee numeric,tax numeric,txn_date date);
    create table day_trades(qty integer,buy_price numeric,sell_price numeric,buy_fee numeric,sell_fee numeric,tax numeric,trade_date date);
    create table trade_plans(id uuid primary key default gen_random_uuid(),symbol text,signal_date date);
    create function create_breakout_plan(p_symbol text,p_signal_date date,p_entry_min numeric,p_entry_max numeric,p_stop_price numeric,p_valid_until date,p_entry_reason text,p_exit_rule text)
    returns uuid language plpgsql as $$ declare saved_id uuid; begin
      if p_symbol='FAIL' then raise exception 'fixture rejects invalid plan'; end if;
      insert into trade_plans(symbol,signal_date) values(p_symbol,p_signal_date) returning trade_plans.id into saved_id;
      return saved_id;
    end $$;
    insert into app_settings values('initial_capital',100),('risk_pct_per_trade',0.01),('commission_base_rate',0.001425),('commission_discount',0.6),('sell_tax_stock',0.003);
    insert into stock_industry values('AAAA','科技'),('BBBB','科技'),('CCCC','航運');
    insert into holdings_transactions values
      ('AAAA','BUY',1000,100,100,0,current_date-4),
      ('AAAA','SELL',200,120,30,72,current_date-3),
      ('BBBB','BUY',500,50,25,0,current_date-3),
      ('CCCC','BUY',100,200,20,0,current_date-2),
      ('DDDD','BUY',50,100,5,0,current_date-2),
      ('DDDD','SELL',50,110,5,16,current_date-1),
      ('FUTR','BUY',10000,100,100,0,current_date+2);
    insert into day_trades values(1000,10,11,10,11,33,current_date-1),(10000,10,20,0,0,0,current_date+2);
    insert into price_daily values('AAAA',current_date,110),('BBBB',current_date,60),('CCCC',current_date,210),('BBBB',current_date-1,55);`);
  await db.exec(migration);
  return db;
}

// PostgREST sends dates as strings; PGlite normally decodes them into Dates.
const context = async (db) => {
  const row = (await db.query("select * from v_plan_risk_context")).rows[0];
  return { ...row,
    price_date: row.price_date instanceof Date ? row.price_date.toISOString().slice(0,10) : row.price_date,
    calculated_at: row.calculated_at instanceof Date ? row.calculated_at.toISOString() : row.calculated_at,
  };
};
const estimateInput = {
  symbol: "AAAA", industry: "科技", entry: 100, stop: 95,
  positionPct: 20, industryPct: 12, slippagePct: 0,
};

test("risk context uses actual transaction cash flows, open positions and day-trade net proceeds", async () => {
  const db = await fixture();
  try {
    const c = await context(db);
    assert.equal(Number(c.cash), 880173);
    assert.equal(Number(c.equity), 1019173);
    assert.equal(c.coverage_ok, true);
    assert.deepEqual(c.positions.map(p => p.symbol).sort(), ["AAAA", "BBBB", "CCCC"]);
    assert.equal(c.positions.find(p => p.symbol === "AAAA").market_value, 88000);
    assert.equal(Number(c.fee_rate), 0.000855);
    const risk = estimateRisk(c, estimateInput, c.price_date);
    assert.equal(risk.shares, 42); // 12% equity cap already contains BOTH technology positions
    assert.deepEqual(risk.limitingFactors, ["產業集中度"]);
    assert.ok(risk.cashRequired <= Number(c.cash));
    assert.ok(risk.estimatedLoss <= risk.riskBudget);
    assert.equal(estimateRisk(c, { ...estimateInput, positionPct: 8 }, c.price_date).shares, 0);
    assert.equal(estimateRisk(c, { ...estimateInput, industryPct: 10 }, c.price_date).shares, 0);
  } finally { await db.close(); }
});

test("risk sizing refuses missing same-session marks, missing industry and negative positions", async () => {
  const db = await fixture();
  try {
    await db.exec("delete from price_daily where symbol='BBBB' and trade_date=current_date");
    let c = await context(db);
    assert.equal(c.coverage_ok, false);
    assert.equal(c.positions.find(p => p.symbol === "BBBB").market_value, null);
    assert.throws(() => estimateRisk(c, estimateInput, c.price_date), /未齊/);
    await db.exec("insert into price_daily values('BBBB',current_date,60); update stock_industry set industry_category=null where symbol='CCCC'");
    c = await context(db);
    assert.equal(c.coverage_ok, false);
    assert.throws(() => estimateRisk(c, estimateInput, c.price_date), /未齊/);
    await db.exec("update stock_industry set industry_category='航運' where symbol='CCCC'; insert into holdings_transactions values('CCCC','SELL',101,210,1,1,current_date)");
    c = await context(db);
    assert.equal(c.coverage_ok, false);
    assert.throws(() => estimateRisk(c, estimateInput, c.price_date), /未齊/);
  } finally { await db.close(); }
});

test("plan and JSON risk snapshot save atomically, including rollback if snapshot persistence fails", async () => {
  const db = await fixture();
  try {
    const c = await context(db);
    const risk = estimateRisk(c, estimateInput, c.price_date);
    const inputs = {p_symbol:"AAAA",p_signal_date:c.price_date,p_entry_min:99,p_entry_max:100,p_stop_price:95,p_valid_until:c.price_date,p_entry_reason:"fixture entry",p_exit_rule:"fixture exit"};
    const saved = await db.query("select create_breakout_plan_with_risk($1::jsonb,$2::jsonb) id", [JSON.stringify(inputs),JSON.stringify(risk)]);
    const plan = (await db.query("select * from trade_plans where id=$1", [saved.rows[0].id])).rows[0];
    assert.deepEqual(plan.risk_snapshot, risk);
    await assert.rejects(db.query("select create_breakout_plan_with_risk($1::jsonb,$2::jsonb)", [JSON.stringify({...inputs,p_symbol:"FAIL"}),JSON.stringify(risk)]), /fixture rejects/);
    await db.exec(`create function reject_risk_snapshot() returns trigger language plpgsql as $$ begin raise exception 'fixture snapshot failure'; end $$;
      create trigger reject_risk before update of risk_snapshot on trade_plans for each row execute function reject_risk_snapshot();`);
    await assert.rejects(db.query("select create_breakout_plan_with_risk($1::jsonb,$2::jsonb)", [JSON.stringify(inputs),JSON.stringify(risk)]), /fixture snapshot failure/);
    assert.equal((await db.query("select count(*)::int n from trade_plans")).rows[0].n, 1);
    for (const role of ["anon","authenticated"])
      assert.equal((await db.query("select has_function_privilege($1,'public.create_breakout_plan_with_risk(jsonb,jsonb)','execute') allowed", [role])).rows[0].allowed, false);
  } finally { await db.close(); }
});
