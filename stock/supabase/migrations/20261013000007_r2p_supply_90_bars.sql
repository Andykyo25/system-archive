-- R2p 套牢量回到驗證規格的 90 根(2026-10-13)
--
-- 實查:R2p 上線研究 tools/scan-backtest/prodfeas.mjs 選定「60 日高 + 90 根套牢量 + 0050 季線」,
-- r2p.mjs 的 56% 也是用 supply90;但 v_scan_verdict 呼叫的 scan_supply_share 是 9/23 的 120 根版本
-- (pattern / watch 也在用)→ 9/29 上線起,有長歷史的股票用 120 根、非池股因保留窗只有 ≈91 根而碰巧≈規格。
-- 20261013000001 把保留窗拉到 200 天後,所有股票都會變 120 根 = 全面偏離規格(6924:90 根 7.0% 通過、
-- 120 根 18.4% 不通過 → 10/12 名單被錯換成 6834)。
-- 作法:新增 scan_supply_share(symbol, date, price, bars) 指定根數版本;v_scan_verdict 改用 90 根。
--   3 參數的 120 根版本不動(scan_pattern / verdict watch 照舊)。
--   200 天保留窗保留:確保過年等長假後仍 ≥ 90 根(135 天在 2 月可能不足 90 根)。
--
-- rollback:把 v_scan_verdict 內 scan_supply_share(b.symbol, b.trade_date, b.close, 90) 換回 3 參數版本,
--   drop function public.scan_supply_share(text, date, numeric, integer);refresh mv_scan_verdict。

create or replace function public.scan_supply_share(p_symbol text, p_date date, p_price numeric, p_bars integer)
returns numeric
language sql
stable
as $$
  select round(
    coalesce(sum(volume) filter (where close > p_price and close <= p_price * 1.2), 0)::numeric
    / nullif(sum(volume), 0), 3)
  from (
    select close, volume from public.price_daily
    where symbol = p_symbol and trade_date <= p_date
    order by trade_date desc
    limit p_bars
  ) d
$$;
comment on function public.scan_supply_share(text, date, numeric, integer) is
  '上方套牢量(指定根數):最近 p_bars 根中收盤落在 (價格, 價格×1.2] 的成交量佔比。R2p 規格 90 根(tools/scan-backtest/r2p.mjs supply90)。';

do $mig$
declare
  src text;
  old_call constant text := 'scan_supply_share(b.symbol, b.trade_date, b.close)';
begin
  src := pg_get_viewdef('public.v_scan_verdict'::regclass, true);
  if position('b.close, 90)' in src) = 0 then
    if (length(src) - length(replace(src, old_call, ''))) / length(old_call) <> 1 then
      raise exception 'v_scan_verdict: supply call not found exactly once, abort';
    end if;
    src := replace(src, old_call, 'scan_supply_share(b.symbol, b.trade_date, b.close, 90)');
    execute 'create or replace view public.v_scan_verdict as ' || src;
  end if;
end $mig$;

refresh materialized view concurrently public.mv_scan_verdict;

-- 更正 20261013000001 的函式註解(原寫「≥120 根」是錯的規格)
comment on function public.cleanup_market_prices is
  '全市場價格 200 日曆天滾動窗(R2p 套牢量規格 90 根,200 天確保長假後仍 ≥ 90 根):只清從未進過任何池 / 看多候選的股;
   進過池、候選、交易過的永久保留(L38 PIT)。';
