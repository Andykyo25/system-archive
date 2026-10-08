import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const sql=async name=>readFile(new URL('../supabase/migrations/'+name+'.sql',import.meta.url),'utf8');
test('risk SQL: fresh quotes only, hysteresis, one transition, financial baseline and delivery lease',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create table held(symbol text,net_qty bigint,current_price numeric,price_source text,market_state text,as_of_ts timestamptz,stop_loss_price numeric);
      create view v_holdings_advice as select * from held;
      create table stock_fundamentals_quarterly(symbol text,period_end date,eps numeric,ocf numeric);
      create table etf_metadata(symbol text);
      insert into held values('A',1000,92,'twse_mis','REGULAR','2026-10-08T02:00Z',90),('B',2000,50,'twse_mis','REGULAR','2026-10-08T02:00Z',40);
      insert into stock_fundamentals_quarterly values('A','2026-03-31',-1,-100);`);
    await db.exec(await sql('20261008075203_holding_risk_monitor'));
    const check=async()=> (await db.query("select evaluate_holding_risks('2026-10-08T02:01Z') n")).rows[0].n;
    assert.equal(await check(),3); // near stop + two concentrations, no old financial alarm
    assert.equal(await check(),0);
    await db.exec("update held set current_price=93.6 where symbol='A'");assert.equal(await check(),0);
    await db.exec("update held set current_price=96 where symbol='A'");assert.equal(await check(),1);
    await db.exec("update held set current_price=80,price_source='twse_mis_mid' where symbol='A'");assert.equal(await check(),0);
    await db.exec("update held set price_source='twse_mis',as_of_ts='2026-10-07T02:00Z' where symbol='A'");assert.equal(await check(),0);
    await db.exec("insert into stock_fundamentals_quarterly values('A','2026-06-30',-2,-200)");
    assert.equal(await check(),1);assert.equal(await check(),0);
    const token='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
    const claimed=(await db.query('select * from claim_holding_risks($1)',[token])).rows;
    assert.equal(claimed.length,5);assert.equal((await db.query('select * from claim_holding_risks($1)',[other])).rows.length,0);
    assert.equal((await db.query('select finish_holding_risk($1,$2,true) ok',[claimed[0].id,other])).rows[0].ok,false);
    assert.equal((await db.query('select finish_holding_risk($1,$2,true) ok',[claimed[0].id,token])).rows[0].ok,true);
    assert.equal((await db.query("select has_function_privilege('anon','evaluate_holding_risks(timestamptz)','execute') ok")).rows[0].ok,false);
    await db.exec("update held set price_source='twse_mis',as_of_ts='2026-10-08T02:00Z',current_price=89.9 where symbol='A'");
    assert.equal(await check(),1);
    await db.exec("update held set current_price=90.1 where symbol='A'");assert.equal(await check(),0);
    await db.exec("update held set current_price=89.8 where symbol='A'");assert.equal(await check(),0);
  }finally{await db.close();}
});
test('worker schedule SQL: existing jobs preserved, credentials stay inside database, worker allowlist enforced',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create schema cron;create table cron.job(jobname text primary key,schedule text,command text);
      create function cron.schedule(text,text,text) returns bigint language plpgsql as $$begin insert into cron.job values($1,$2,$3);return 1;end$$;
      create schema net;create table net.calls(url text,headers jsonb);
      create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin insert into net.calls values($1,$2);return 1;end$$;
      create function read_edge_function_auth() returns text language sql as $$select 'fixture-trusted-key'::text$$;
      insert into cron.job values('check-price-alerts','existing','existing');
      create table held(symbol text);create view v_holdings_current as select * from held;
      create table holding_risk_events(notified boolean,delivery_after timestamptz);`);
    await db.exec(await sql('20261008075204_optimization_jobs'));
    assert.equal((await db.query('select count(*) n from cron.job')).rows[0].n,7);
    assert.equal((await db.query("select command from cron.job where jobname='check-price-alerts'")).rows[0].command,'existing');
    await assert.rejects(db.query("select invoke_optimization_worker('unknown')"),/not allowed/);
    await db.query("select invoke_optimization_worker('run-r2p-forward')");
    assert.equal((await db.query('select headers from net.calls')).rows[0].headers.Authorization,'Bearer fixture-trusted-key');
    assert.equal((await db.query("select has_function_privilege('anon','invoke_optimization_worker(text)','execute') ok")).rows[0].ok,false);
  }finally{await db.close();}
});
test('forward SQL: prospective freeze and versioned CAS commit cannot rewrite an existing day',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create table price_daily(symbol text,trade_date date,adj_factor numeric);
      create table scan(symbol text,trade_date date,score_total int,day_pct numeric,close numeric,atr14 numeric);
      create view v_scan_verdict as select * from scan;
      create table rank(symbol text);create view v_stock_rank as select * from rank;`);
    await db.exec(await sql('20261008075202_r2p_forward'));
    const payload={version:'R2p-forward-v1',lastDate:'2026-10-08',cash:1000000,equity:1000000,maxDrawdown:0,benchmark:0,positions:[],trades:[]};
    const commit=async(rev,p)=>(await db.query('select commit_r2p_forward($1,$2::jsonb) ok',[rev,JSON.stringify(p)])).rows[0].ok;
    assert.equal(await commit(-1,payload),true);assert.equal(await commit(-1,payload),false);
    assert.equal(await commit(0,payload),false);
    assert.equal(await commit(0,{...payload,lastDate:'2026-10-09'}),true);
    assert.equal(await commit(0,{...payload,lastDate:'2026-10-12'}),false);
    assert.equal((await db.query('select count(*) n from r2p_forward_daily')).rows[0].n,2);
    assert.equal((await db.query("select has_table_privilege('service_role','r2p_forward_batches','insert') ok")).rows[0].ok,false);
  }finally{await db.close();}
});
