-- v_breakout_scan 的籌碼視窗改綁掃描日(2026-08-28)
--
-- 問題([[L67]] 家族,與 08-17 的 dev_ma20 bug **完全同型**):
-- chips CTE 原本寫
--     where i.trade_date > (select max(trade_date) from stock_institutional) - 8
-- 也就是把「外資 5 日買超」的視窗綁在**籌碼表自己的最新日**,而不是這次掃描的價格日。
-- 今天兩張表剛好對齊(都是最新交易日)所以看不出問題,但只要籌碼落後 N 天
-- (todo.md 記載過 shareholding 停更 16 天、institutional 撞 150 秒牆多次),
-- /scan 上那個「外資買超」數字就是**結束於 N 天前的窗**,卻和當日收盤價並排顯示。
-- 兩條路徑量同一個概念、取不同時點 —— 不會報錯,數字看起來也很合理。
--
-- 修法:
--   1. 視窗綁 bounds.last_d(= 這次掃描的價格日),與 close / day_pct / ma20 同一個時點
--   2. 籌碼表最新日**落後於**價格日時,整個 CTE 回空 → left join 產生 NULL
--      = 「不知道」而不是「拿舊資料裝作是今天的」([[L45]] 不可用近似值填充)
--
-- 實作方式:**不重打整個 view**。v_breakout_scan 內含一長串產業排除清單(30+ 個字串),
-- 手動重抄一次就有打錯的風險,而打錯會靜默改變掃描池([[L46]])。
-- 改成從 pg_get_viewdef 取出線上定義、只對 chips CTE 做 regexp 替換再 create or replace,
-- 其餘每一個字元原封不動。
--
-- rollback:重跑 20260806000002_v_breakout_scan_scored.sql

do $$
declare
  def    text;
  newdef text;
begin
  select pg_get_viewdef('public.v_breakout_scan'::regclass, true) into def;

  -- 1) chips CTE 加進 bounds,才能取到掃描日
  newdef := replace(def,
    'FROM stock_institutional i',
    'FROM stock_institutional i, bounds b');

  -- 2) 視窗改綁 bounds.last_d,並加上「籌碼沒跟上就整組回空」的閘
  newdef := regexp_replace(newdef,
    'i\.trade_date > \(\( SELECT max\(stock_institutional\.trade_date\) - 8\s+FROM stock_institutional\)\)',
    'i.trade_date > (b.last_d - 8) AND i.trade_date <= b.last_d '
    'AND (( SELECT max(stock_institutional.trade_date) FROM stock_institutional)) >= b.last_d');

  if newdef = def then
    raise exception 'v_breakout_scan chips CTE 沒有被替換到 — 線上定義與預期不符,中止';
  end if;

  execute 'create or replace view public.v_breakout_scan as ' || newdef;
end $$;

comment on view public.v_breakout_scan is
  '起漲點掃描。fgn_net_5d 的視窗綁掃描日(bounds.last_d);籌碼表落後於價格日時整欄回 NULL,'
  '不以舊窗充當當日籌碼。';
