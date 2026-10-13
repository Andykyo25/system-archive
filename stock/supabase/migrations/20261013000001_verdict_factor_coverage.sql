-- 看多候選進榜即有三面因子(D1)+ 籌碼因子名單對齊回測(D2)+ R2p 套牢量歷史(2026-10-13)
--
-- 問題(10/13 正式庫唯讀實查):
--   G1 今日看多 6924/3617/3605 不在因子計算名單 → v_stock_rank 無列 → 前端「因子不足」。
--      v_stock_score(基本面)早已有 3 檔、7 項可算 6~7 項;缺的只是名單。
--   G2 v_chip_factors 的 universe 只有 4 個來源(無 etf_metadata / universe_dynamic),
--      v_price_factors 是 6 個,回測 score_universe_at 的籌碼也算熱股池(PIT)。
--      → 熱股池 50 檔 chip_count_total>0 僅 2 檔;線上 vs score_universe_at(current_date)
--        逐檔 chip_count_total 不一致 40 檔(38 檔熱股池),動能面 0 檔。籌碼資料其實已在收
--        (v_fetch_chip_universe 含熱股池),只是 view 沒讀 —— 兩份手寫名單漂移(L32 變形)。
--   G3 freeze_r2p_forward 讀 v_stock_rank → R2p 前向帳本 dimensions 近兩批 6 筆有 5 筆 null。
--   G4 cleanup_market_prices 只留非池股 135 日曆天(≈91 根);R2p 的 scan_supply_share 規格是
--      最近 120 根(回測同),全市場 1,996 檔中 1,481 檔不足 120 根 → 線上「上方套牢 ≤10%」
--      用的是截短資料。另外候選 7 日後不在保留名單,會被清掉補回來的歷史。
--
-- 作法:
--   1. v_rank_universe(排名母體 = v_price_factors 現行 6 來源)/ v_factor_universe(= 排名母體
--      ∪ 近 7 日看多候選,與 v_collection_priority 同窗)。v_price_factors / v_chip_factors 的
--      universe CTE 都改讀 v_factor_universe → 單一來源,不再各自維護(G1 + G2)。
--   2. D1 排名中立:v_stock_rank_all = 原 v_stock_rank + rank_eligible,expected_rank 先排
--      rank_eligible。v_stock_rank 改為 v_stock_rank_all where rank_eligible → 欄位不變、
--      列只含排名母體、名次與沒有候選時相同;8 個下游 view、paper_track_tick、回檔波段都看不到候選。
--   3. freeze_r2p_forward 改讀 v_stock_rank_all(只影響之後凍結的批次,不改寫歷史批次)。
--   4. cleanup_market_prices:保留窗 135 → 200 日曆天(≥120 根 + 假日緩衝),並保留曾入候選者。
--      (覆寫 2026-07-03「90 日滾動窗」:當時 R2p 尚未上線,120 根需求是之後才出現的。)
--
-- 不動 score_universe_at:collection_candidates 是 upsert(signal_date 會被覆寫)不是 PIT 紀錄,
--   且 D1 已讓候選不進排名,回測母體維持原定義。D2 是讓線上向 score_universe_at 對齊。
--
-- 所有改寫都用 pg_get_viewdef / pg_get_functiondef + 字串替換(L49 機械改寫),替換目標先驗證
-- 恰出現 1 次且來源清單如預期,否則 raise;已改過就跳過(冪等)。
--
-- rollback:tasks/rollback-20261013.sql(由 schema_rollback_snapshots 還原改動前定義原文)。

-- 0. rollback 快照:改動前的定義原文(重跑不覆蓋,永遠保留第一次的原始版本)
create table if not exists public.schema_rollback_snapshots(
  tag text not null,
  object_name text not null,
  kind text not null check (kind in ('view','function')),
  definition text not null,
  saved_at timestamptz not null default now(),
  primary key (tag, object_name)
);
alter table public.schema_rollback_snapshots enable row level security;
revoke all on public.schema_rollback_snapshots from public, anon, authenticated;
grant all on public.schema_rollback_snapshots to service_role;

insert into public.schema_rollback_snapshots(tag, object_name, kind, definition)
select '20261013_verdict_factor_coverage', x.name, x.kind, x.def
from (values
  ('v_price_factors', 'view', pg_get_viewdef('public.v_price_factors'::regclass, true)),
  ('v_chip_factors', 'view', pg_get_viewdef('public.v_chip_factors'::regclass, true)),
  ('v_stock_rank', 'view', pg_get_viewdef('public.v_stock_rank'::regclass, true)),
  ('freeze_r2p_forward', 'function', pg_get_functiondef('public.freeze_r2p_forward()'::regprocedure)),
  ('cleanup_market_prices', 'function', pg_get_functiondef('public.cleanup_market_prices()'::regprocedure))
) x(name, kind, def)
where to_regclass('public.v_stock_rank_all') is null
on conflict do nothing;

-- 1. 名單:排名母體 / 因子計算名單
create or replace view public.v_rank_universe as
select symbol from public.stock_universe
union select symbol from public.industry_stocks
union select symbol from public.watchlist
union select symbol from public.holdings_transactions
union select symbol from public.etf_metadata
union select symbol from public.universe_dynamic where active;

create or replace view public.v_factor_universe as
select symbol from public.v_rank_universe
union
select symbol from public.collection_candidates where signal_date >= current_date - 7;

comment on view public.v_rank_universe is
  '排名母體(expected_rank / paper_track / 回檔波段只看這裡)。改這裡 = 改策略母體,需同步檢查 score_universe_at(L32)。';
comment on view public.v_factor_universe is
  '因子計算名單 = 排名母體 ∪ 近 7 日看多候選。v_price_factors / v_chip_factors 共用,候選只供顯示不進排名。';
revoke all on public.v_rank_universe, public.v_factor_universe from public, anon, authenticated;
grant select on public.v_rank_universe, public.v_factor_universe to service_role;

-- 2. v_price_factors / v_chip_factors 改讀 v_factor_universe
do $mig$
declare
  src text;
  cte text;
  s text;
begin
  src := pg_get_viewdef('public.v_price_factors'::regclass, true);
  if position('v_factor_universe' in src) = 0 then
    cte := substring(src from 'universe_symbols AS \((.*?)\), ranked AS \(');
    if cte is null then raise exception 'v_price_factors: universe_symbols CTE not found, abort'; end if;
    foreach s in array array['stock_universe','industry_stocks','watchlist','holdings_transactions','etf_metadata','universe_dynamic'] loop
      if position(s in cte) = 0 then raise exception 'v_price_factors: universe source % missing, abort', s; end if;
    end loop;
    if (length(cte) - length(replace(cte, 'UNION', ''))) / 5 <> 5 then
      raise exception 'v_price_factors: expected 6 universe sources, abort';
    end if;
    src := replace(src, 'universe_symbols AS (' || cte || ')',
                   'universe_symbols AS ( SELECT v_factor_universe.symbol FROM v_factor_universe )');
    if position('v_factor_universe' in src) = 0 then raise exception 'v_price_factors: rewrite failed'; end if;
    execute 'create or replace view public.v_price_factors as ' || src;
  end if;

  src := pg_get_viewdef('public.v_chip_factors'::regclass, true);
  if position('v_factor_universe' in src) = 0 then
    cte := substring(src from 'universe_symbols AS \((.*?)\), inst_recent AS \(');
    if cte is null then raise exception 'v_chip_factors: universe_symbols CTE not found, abort'; end if;
    foreach s in array array['stock_universe','industry_stocks','watchlist','holdings_transactions'] loop
      if position(s in cte) = 0 then raise exception 'v_chip_factors: universe source % missing, abort', s; end if;
    end loop;
    if position('etf_metadata' in cte) > 0 or position('universe_dynamic' in cte) > 0
       or (length(cte) - length(replace(cte, 'UNION', ''))) / 5 <> 3 then
      raise exception 'v_chip_factors: universe differs from the audited 4 sources, abort';
    end if;
    src := replace(src, 'universe_symbols AS (' || cte || ')',
                   'universe_symbols AS ( SELECT v_factor_universe.symbol FROM v_factor_universe )');
    if position('v_factor_universe' in src) = 0 then raise exception 'v_chip_factors: rewrite failed'; end if;
    execute 'create or replace view public.v_chip_factors as ' || src;
  end if;
end $mig$;

-- 3. D1:v_stock_rank_all(含候選)+ v_stock_rank(只含排名母體,欄位與名次不變)
do $mig$
declare
  src text;
  tail text;
  cols text;
  eligible constant text := '(EXISTS ( SELECT 1 FROM v_rank_universe ru WHERE ru.symbol = s.symbol))';
  old_key constant text := 'row_number() OVER (ORDER BY (fund_count_total > 0) DESC, weighted_score DESC NULLS LAST, symbol) AS expected_rank';
begin
  if to_regclass('public.v_stock_rank_all') is null then
    src := pg_get_viewdef('public.v_stock_rank'::regclass, true);
    if (length(src) - length(replace(src, old_key, ''))) / length(old_key) <> 1 then
      raise exception 'v_stock_rank: expected_rank key not found exactly once, abort';
    end if;
    src := replace(src, old_key,
      'row_number() OVER (ORDER BY ' || eligible || ' DESC, (fund_count_total > 0) DESC, weighted_score DESC NULLS LAST, symbol) AS expected_rank');
    tail := substring(src from '(mom_strong_persist\s+FROM scored s;?\s*)$');
    if tail is null then raise exception 'v_stock_rank: select tail not found, abort'; end if;
    src := left(src, length(src) - length(tail))
      || 'mom_strong_persist, ' || eligible || ' AS rank_eligible FROM scored s';
    execute 'create view public.v_stock_rank_all as ' || src;

    select string_agg(quote_ident(attname), ', ' order by attnum) into cols
    from pg_attribute
    where attrelid = 'public.v_stock_rank'::regclass and attnum > 0 and not attisdropped;
    execute format('create or replace view public.v_stock_rank as select %s from public.v_stock_rank_all where rank_eligible', cols);
  end if;
end $mig$;

comment on view public.v_stock_rank_all is
  'v_stock_rank + 看多候選(rank_eligible=false,排在所有排名母體之後)。只供顯示三面因子,選股 / 排名 / paper_track 一律讀 v_stock_rank。';
grant select on public.v_stock_rank_all to anon, authenticated, service_role;

-- 4. R2p 前向帳本的 dimensions 改讀含候選的 view;5. 價格保留窗 + 候選保留
do $mig$
declare
  src text;
  anchor constant text := 'and not exists (select 1 from public.universe_dynamic ud where ud.symbol = p.symbol)';
begin
  src := pg_get_functiondef('public.freeze_r2p_forward()'::regprocedure);
  if position('v_stock_rank_all' in src) = 0 then
    if (select count(*) from regexp_matches(src, 'from\s+public\.v_stock_rank\s+r\s+where', 'g')) <> 1 then
      raise exception 'freeze_r2p_forward: v_stock_rank lookup not found exactly once, abort';
    end if;
    execute regexp_replace(src, 'from(\s+)public\.v_stock_rank(\s+)r(\s+)where', 'from\1public.v_stock_rank_all\2r\3where');
  end if;

  src := pg_get_functiondef('public.cleanup_market_prices()'::regprocedure);
  if position('collection_candidates' in src) = 0 then
    if (length(src) - length(replace(src, anchor, ''))) / length(anchor) <> 1
       or (length(src) - length(replace(src, 'current_date - 135', ''))) / length('current_date - 135') <> 1 then
      raise exception 'cleanup_market_prices: definition differs from audited version, abort';
    end if;
    src := replace(src, anchor, anchor || E'\n      and not exists (select 1 from public.collection_candidates cc where cc.symbol = p.symbol)');
    src := replace(src, 'current_date - 135', 'current_date - 200');
    execute src;
  end if;
end $mig$;

comment on function public.cleanup_market_prices is
  '全市場價格 200 日曆天滾動窗(≥120 根,R2p scan_supply_share 規格):只清從未進過任何池 / 看多候選的股;
   進過池、候選、交易過的永久保留(L38 PIT)。';
