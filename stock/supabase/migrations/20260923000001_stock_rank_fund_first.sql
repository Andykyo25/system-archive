-- v_stock_rank:無基本面資料的標的排到有基本面的個股之後(2026-09-23)
--
-- 問題:weighted_score 對「缺維度」做權重再正規化 → ETF(fund/chip 全空、只有 mom 2/2)
--   得 75 分,排在幾乎所有個股前面。實查 top30 有 23 檔 ETF;paper_picks 8/15 批
--   top5 全是 ETF(含反向 00632R / 00664R),9/12 批 3/5 是 ETF。
-- 做法:只改 expected_rank 的排序鍵,先比 (fund_count_total > 0)。
--   不刪列、不改 weighted_score → 8 個下游 view 與 paper_track_tick 欄位/列數皆不變
--   (ETF 持股在 v_holdings_advice 仍有列,只是名次在個股之後)。
-- rollback:把 new_key 換回 old_key 重跑同一段 DO block。
do $$
declare
  def text := pg_get_viewdef('public.v_stock_rank'::regclass, true);
  old_key text := 'row_number() OVER (ORDER BY weighted_score DESC NULLS LAST, symbol) AS expected_rank';
  new_key text := 'row_number() OVER (ORDER BY (fund_count_total > 0) DESC, weighted_score DESC NULLS LAST, symbol) AS expected_rank';
  newdef text;
begin
  newdef := replace(def, old_key, new_key);
  if newdef = def then
    raise exception 'v_stock_rank: expected_rank key not found, abort';
  end if;
  execute 'create or replace view public.v_stock_rank as ' || newdef;
end $$;
