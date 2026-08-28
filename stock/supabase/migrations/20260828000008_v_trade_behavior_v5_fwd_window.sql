-- v_trade_behavior v5:fwd_max20_pct 統一觀察視野(2026-08-28)
--
-- 問題([[L67]] 家族,與 08-17 那兩個 bug 同型):
-- `fwd_20d_pct` 在 `fwd_days_available < 20` 時**正確回 NULL**(不夠 20 天就不評),
-- 但同一組的 `fwd_max20_pct` **有幾天算幾天** —— 同一個欄位裡混著 7 天、9 天、16 天、19 天、
-- 20 天的最大值。
--
-- 後果:任何「賣掉之後桌上還留多少」的聚合,量到的一半是「這筆交易多久以前發生」,
-- 而不是「賣得早不早」。近期交易觀察窗短、max 自然小 → **系統性低估近期交易的機會成本**。
-- 一樣不會報錯,數字一樣看起來很合理。
--
-- 修法:加上 `fwd_days_available >= 20` 條件,與 fwd_20d_pct 完全對齊。
-- 「不知道」就回 NULL,不用短窗的近似值充數([[L45]])。
--
-- 本次翻轉的 4 筆(全部由數值 → NULL,無反向):
--   3481 2026-08-03  19 天  14.69
--   2408 2026-08-06  16 天  19.82
--   2408 2026-08-17   9 天   4.24
--   1815 2026-08-19   7 天  35.53   ← 只看 7 天卻是全表最大值,最能說明問題
-- 其餘 14 筆(fwd_days_available = 20)數值零漂移。
--
-- 實作:與 20260828000007 同一手法 —— 從 pg_get_viewdef 取線上定義做定點替換,
-- 不重打整個 view(v_trade_behavior 是三層巢狀 + 6 個重複計算 MA20 的相關子查詢,
-- 重抄的風險遠大於收益)。替換沒命中就 raise 中止,不會靜默套用半套。
--
-- rollback:依序重跑 20260703000001(v2)+ 20260711000001(v3)+ 20260817000001(v4)

do $$
declare
  def    text;
  newdef text;
begin
  select pg_get_viewdef('public.v_trade_behavior'::regclass, true) into def;

  newdef := replace(def,
    'WHEN base.fwd_max20_close IS NOT NULL AND base.sell_price > 0::numeric THEN',
    'WHEN base.fwd_max20_close IS NOT NULL AND base.sell_price > 0::numeric AND base.fwd_days_available >= 20 THEN');

  if newdef = def then
    raise exception 'v_trade_behavior fwd_max20_pct 條件沒有被替換到 — 線上定義與預期不符,中止';
  end if;

  execute 'create or replace view public.v_trade_behavior as ' || newdef;
end $$;

comment on view public.v_trade_behavior is
  '已實現交易的行為分析。fwd_20d_pct 與 fwd_max20_pct 都要求 fwd_days_available >= 20,'
  '不足 20 天一律回 NULL(不可用短窗近似值填充)。dev_ma20_at_buy 以成交價計、'
  'dev_ma20_at_close 是 08-17 之前的收盤價版本,保留當稽核錨點。';
