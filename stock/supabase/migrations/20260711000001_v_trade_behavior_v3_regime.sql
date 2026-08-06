-- v_trade_behavior v3(規畫④A 2026-07-11):append regime_60d_at_entry
-- = 開倉日當下 0050 近 61 筆(≈一季)還原報酬%(同 dashboard regime 口徑)。
-- L37 append-only:DO block 用 pg_get_viewdef 機械包裹原 view,原欄位名稱/順序零變動,
-- 新欄 append 最尾端 → create or replace 合法、零 cascade。零手抄(L49 精神)。
-- Gate-0 實證(2026-07-11):7 筆追高/回追 regime = 31.7/30.9/32.0/23.4/23.4/42.9/47.9,
-- 5 勝 @ +23~32、2 敗 @ +43~48 — U 型地雷區(10-20)零命中,警示採動態呈現非假門檻。
-- rollback:重跑 20260703000001 的 v2 定義。
do $$
declare
  def text;
begin
  def := pg_get_viewdef('public.v_trade_behavior'::regclass);
  if position('regime_60d_at_entry' in def) > 0 then
    raise notice 'v3 already applied, skip';
    return;
  end if;
  def := rtrim(def, E' \n;');
  execute 'create or replace view public.v_trade_behavior as '
    || 'select vt.*, ('
    || 'select (max(b.close*coalesce(b.adj_factor,1)) filter (where b.rn=1) / '
    || 'nullif(max(b.close*coalesce(b.adj_factor,1)) filter (where b.rn=61),0) - 1) * 100 '
    || 'from (select p.close, p.adj_factor, row_number() over (order by p.trade_date desc) as rn '
    || 'from public.price_daily p where p.symbol=''0050'' and p.close>0 and p.trade_date <= vt.entry_date '
    || 'order by p.trade_date desc limit 61) b'
    || ') as regime_60d_at_entry from (' || def || ') vt';
end $$;
