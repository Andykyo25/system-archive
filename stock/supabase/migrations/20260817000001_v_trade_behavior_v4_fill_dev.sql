-- v_trade_behavior v4(2026-08-17):dev_ma20_at_buy / is_chase_buy 改用「實際成交價」
-- 而非「進場日收盤價」。
--
-- 動機:BuyForm 的追高警示走 v_entry_quality.dev_ma20_pct(即時價 vs MA20)= 下單當下
-- 你看得到的價;v_trade_behavior 卻用當日收盤價回算,兩條路徑量的不是同一件事。
-- 收盤價在你下單當下並不存在,拿它當「你追不追高」的事後判定不成立。
--
-- 一致化:成交價是原始價,MA20 是還原價 → 分子乘上「進場日(或之前最近一筆)的 adj_factor」
-- 才同基準。2408/3006/6213 在此期間 adj_factor ≠ 1(0.9917~0.9968),不乘會差 0.3~0.8pp。
--
-- 影響(17 筆全量實測,2026-08-17):唯一翻轉 = 2408 2026-06-05(備註「暴跌買進」,
-- +106,180 = 最大單筆獲利)dev 9.20% → 10.56%,跨過 +10% 門檻。而「追高比較差」這個
-- 結論完全靠這一筆落在哪一邊:
--   收盤價(舊):追高 8 筆平均 +11,549 / 非追高 8 筆平均 +33,078
--   成交價(新):追高 9 筆平均 +22,063 / 非追高 7 筆平均 +22,635  → 差異消失
--
-- L37 append-only:既有 18 欄名稱/型別/順序零變動(只換兩欄的「表達式」= create or replace
-- 合法且零 cascade),新欄 dev_ma20_at_close 保留舊值當稽核錨點([[L39]] 退版錨點精神)。
-- MA20 口徑(還原收盤、含進場日、不足 20 筆回 null)一字不動 → 唯一變數可歸因。
-- 零手抄:用 pg_get_viewdef 機械包裹既有定義(同 v3 做法,L49 精神)。
--
-- rollback:依序重跑 20260703000001(v2)+ 20260711000001(v3),即回到收盤價版本。
do $$
declare
  def   text;
  ma20  text;
  af    text;
begin
  def := pg_get_viewdef('public.v_trade_behavior'::regclass);
  if position('dev_ma20_at_close' in def) > 0 then
    raise notice 'v4 already applied, skip';
    return;
  end if;
  def := rtrim(def, E' \n;');

  -- 與內層 ma20_at_buy 完全相同的口徑(還原收盤、含進場日、不足 20 筆回 null)
  ma20 := '(select case when count(*) >= 20 then avg(w.ac) else null::numeric end '
       || 'from (select pp.close * coalesce(pp.adj_factor, 1) as ac from public.price_daily pp '
       || 'where pp.symbol = vt.symbol and pp.trade_date <= vt.entry_date and pp.close > 0 '
       || 'order by pp.trade_date desc limit 20) w)';

  -- 進場日(或之前最近一筆)的還原係數 — 取法與內層 close_at_buy 同一筆 bar
  af := '(select coalesce(pp.adj_factor, 1) from public.price_daily pp '
     || 'where pp.symbol = vt.symbol and pp.close > 0 and pp.trade_date <= vt.entry_date '
     || 'order by pp.trade_date desc limit 1)';

  execute 'create or replace view public.v_trade_behavior as select '
    || 'vt.txn_id, vt.symbol, vt.sell_date, vt.qty_sold, vt.realized_pnl, vt.realized_pct, '
    || 'vt.is_win, vt.holding_days, vt.fwd_days_available, vt.fwd_20d_pct, vt.fwd_max20_pct, '
    || 'vt.entry_date, vt.entry_price, '
    || 'case when ' || ma20 || ' > 0 then '
    ||   'round((vt.entry_price * ' || af || ' / ' || ma20 || ' - 1) * 100, 2) '
    ||   'else null::numeric end as dev_ma20_at_buy, '
    || 'vt.ret20d_at_buy, '
    || 'case when ' || ma20 || ' > 0 then '
    ||   '((vt.entry_price * ' || af || ' / ' || ma20 || ' - 1) * 100) > 10 '
    ||   'else null::boolean end as is_chase_buy, '
    || 'vt.is_reentry_buy, vt.regime_60d_at_entry, '
    || 'vt.dev_ma20_at_buy as dev_ma20_at_close '
    || 'from (' || def || ') vt';
end $$;
