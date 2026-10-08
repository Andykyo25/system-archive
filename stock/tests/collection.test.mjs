import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {collectionNumber,collectionOrder} from '../lib/collection.ts';
test('collection: missing is null, ETF excluded, holdings first and empty responses retry with backoff',()=>{
  for(const x of [null,undefined,'','  ','--',true]) assert.equal(collectionNumber(x),null);
  assert.equal(collectionNumber('1,200'),1200);assert.equal(collectionNumber(0),0);
  const now=Date.parse('2026-10-08T12:00:00Z');
  const rows=[{symbol:'A',priority:3,is_etf:false},{symbol:'B',priority:2,is_etf:false},{symbol:'C',priority:1,is_etf:false},{symbol:'0050',priority:1,is_etf:true}];
  assert.deepEqual(collectionOrder(rows,[],now).map(x=>x.symbol),['C','B','A']);
  assert.deepEqual(collectionOrder(rows,[{symbol:'C',status:'ok',observed_at:'2026-10-07T00:00:00Z'},{symbol:'B',status:'empty',observed_at:'2026-10-08T10:00:00Z'}],now).map(x=>x.symbol),['A']);
});
test('collection SQL: additive candidates, ETF excluded, atomic quota and restricted RPC',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role;
    create table holdings(symbol text);create view v_holdings_current as select * from holdings;
    create table watchlist(symbol text);create table industry_stocks(symbol text);create table stock_universe(symbol text);
    create table etf_metadata(symbol text);create view v_fetch_universe_stocks as select symbol from holdings;
    create table stock_fundamentals_quarterly(symbol text);create table api_quota_state(source text,quota_date date,used int,budget int,primary key(source,quota_date));
    create table scan_fixture(symbol text,trade_date date,score_total int,day_pct numeric);
    create view v_scan_verdict as select * from scan_fixture;
    insert into holdings values('0050'),('2330');insert into etf_metadata values('0050');
    insert into scan_fixture values('8442',current_date,80,5);`);
    await db.exec(await readFile(new URL('../supabase/migrations/20261008075201_collection_priority.sql',import.meta.url),'utf8'));
    await db.exec('select capture_collection_candidates()');
    assert.deepEqual((await db.query('select symbol from v_fetch_universe_stocks order by symbol')).rows.map(x=>x.symbol),['2330','8442']);
    await db.exec("insert into api_quota_state values('finmind',current_date,538,600)");
    assert.equal((await db.query('select reserve_collection_quota(3) ok')).rows[0].ok,false);
    assert.equal((await db.query('select reserve_collection_quota(2) ok')).rows[0].ok,true);
    assert.equal((await db.query("select has_function_privilege('anon','reserve_collection_quota(integer)','execute') ok")).rows[0].ok,false);
  }finally{await db.close();}
});
