-- 修正 20261013000001:v_chip_factors 改讀 v_factor_universe 後,v_chip_factors 會對名單內每一檔
-- 產生一列(left join),連 etf_metadata 中 63 檔已無任何價格的下市 ETF 也進來
-- → mv_factor_scores / v_stock_rank 590 → 654 列,違反 D1「排名母體列數與名次不變」。
--
-- ETF 不收籌碼(v_fetch_chip_universe 經 v_collection_priority 排除 ETF;實查 ETF 近 60 日法人 0 筆),
-- 舊籌碼名單 4 來源也不含 etf_metadata(實查 stock_universe / industry_stocks / 熱股池內 ETF 0 檔)。
-- → 籌碼名單 = 因子名單扣掉 ETF,再補回 watchlist / 持股(與舊版相同:持有的 ETF 仍有籌碼列)。
--   等同「舊 4 來源 + 熱股池(D2)+ 近 7 日候選(D1)」,且仍跟著 v_factor_universe 走,不會再漂移。
--
-- rollback:tasks/rollback-20261013.sql(還原 v_chip_factors 原文)。

do $mig$
declare
  src text;
  cte text;
begin
  src := pg_get_viewdef('public.v_chip_factors'::regclass, true);
  cte := substring(src from 'universe_symbols AS \((.*?)\), inst_recent AS \(');
  if cte is null then raise exception 'v_chip_factors: universe_symbols CTE not found, abort'; end if;
  if position('etf_metadata' in cte) = 0 then
    if position('v_factor_universe' in cte) = 0 or position('UNION' in cte) > 0 then
      raise exception 'v_chip_factors: expected the 20261013000001 universe, abort';
    end if;
    src := replace(src, 'universe_symbols AS (' || cte || ')',
      'universe_symbols AS ( SELECT fu.symbol FROM v_factor_universe fu'
      || ' WHERE NOT (EXISTS ( SELECT 1 FROM etf_metadata e WHERE e.symbol = fu.symbol))'
      || ' UNION SELECT watchlist.symbol FROM watchlist'
      || ' UNION SELECT holdings_transactions.symbol FROM holdings_transactions )');
    execute 'create or replace view public.v_chip_factors as ' || src;
  end if;
end $mig$;
