-- price_trade_dates:回測取「交易日曆」用(2026-09-30)
--
-- 問題:run-backtest v8(2026-09-06 起)取交易日的方式是逐頁掃 price_daily 的「每一列」
--   (select trade_date … order by trade_date, symbol offset n limit 1000),再在 EF 內去重。
--   OFFSET 成本隨 n 線性成長 → 整體是平方級:30 萬列 = 304 頁,DB 端每頁 4 ms(offset 0)
--   到 ~700 ms(offset 15 萬);M10(2025-05-01~2026-09-30,141.5 s)大半時間耗在這裡。
--   價格表因全市場入庫(2026-05 起 ~2,000 檔/日)急速變大,只會越來越糟。
--   (v7 以前 3 年回測只要 13 s;M10 是 v8 之後的第一個 run,所以才第一次撞牆。)
-- 修法:DB 端 DISTINCT 一次回傳,實測 20 萬列區間 ~300 ms。語意與原本完全相同
--   (區間內任一檔出現過的日期,升冪)。
-- 權限同 score_universe_at:僅 service_role(EF 用 service key 呼叫)。
-- rollback:EF 回退到 v8(git fc82d51)後,drop function public.price_trade_dates(date, date);

create or replace function public.price_trade_dates(p_start date, p_end date)
returns setof date
language sql
stable
as $$
  select distinct trade_date
  from public.price_daily
  where trade_date >= p_start and trade_date <= p_end
  order by trade_date
$$;

revoke execute on function public.price_trade_dates(date, date) from public, anon, authenticated;
grant execute on function public.price_trade_dates(date, date) to service_role;

comment on function public.price_trade_dates(date, date) is
  'run-backtest 交易日曆:[p_start, p_end] 內 price_daily 出現過的日期(升冪、DISTINCT)。取代 EF 內逐頁掃全表(平方級)。';
