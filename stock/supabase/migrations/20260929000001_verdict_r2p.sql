-- 今日看多改 R2p + 3ATR 停損(2026-09-29,Andy:「4 點都改,停損用 3ATR」)
--
-- 依據:tools/scan-backtest(2022-07 ~ 2026-09 全市場、含下市股;tasks/todo.md 2026-09-29)
--   型態 A(漲停 + 跌深)3.7 年勝率 47.5%,2024 / 2025 各約 36%;滾動 60 掃描日信心門檻無預測力(≥55% 時實現 42.6%)。
--   R2p = 候選 score ≥ 80 且 ① 距 60 日收盤高 > −5% ② 上方套牢 ≤ 10% ③ 0050 還原價 > 季線。
--   正式規格(每日前 3 檔;停損 訊號收盤 − 3×ATR14;停利 +10%;最長 20 日):勝率 56.1%,逐年 55 / 51 / 59 / 64。
--   不用 250 日高 / 加權報酬指數:池外股日線只留 135 天(免費方案容量)、market_bench_daily 已退役。
--
-- 1) scan_supply_share:上方無成交量時回 0(原本回 NULL → 創新高的股票被排除)。
--    mv_pick_scorecard 型態 A/D 不受影響(跌深股上方必有量;套用前實查 0 筆)。
-- 2) app_settings.verdict_atr_stop_multiple = 3(持股部位建議用的 atr_stop_multiple = 2 不動)。
-- 3) verdict_plan_levels:停損只用 ATR(不再與月線取較緊者),與 lib/plan-defaults.ts ma20Stop:false 同算法。
-- 4) v_scan_verdict:R2p 前 3 檔;drop v_scan_pattern_stats(信心標籤移除,無其他讀者)。
-- 5) freeze_verdict_watch:讀新設定;pattern 記 'R2p',confidence / up10_pct / n10 留空。
--
-- rollback(依序):
--   drop view public.v_scan_verdict;
--   重建 20260923000004 的 v_scan_pattern_stats 與 v_scan_verdict;
--   drop function public.verdict_plan_levels(numeric, numeric, numeric);
--   重建 20260923000005 的 verdict_plan_levels(numeric, numeric, numeric, numeric) 與 20260923000004 的 freeze_verdict_watch;
--   delete from public.app_settings where key = 'verdict_atr_stop_multiple';
--   scan_supply_share 保留修正即可(舊版回 NULL 是 bug)。

create or replace function public.scan_supply_share(p_symbol text, p_date date, p_price numeric)
returns numeric
language sql stable as $$
  select round(
    coalesce(sum(volume) filter (where close > p_price and close <= p_price * 1.2), 0)::numeric
      / nullif(sum(volume), 0), 3)
  from (
    select close, volume from public.price_daily
    where symbol = p_symbol and trade_date <= p_date
    order by trade_date desc
    limit 120
  ) d
$$;

insert into public.app_settings (key, value, description)
values ('verdict_atr_stop_multiple', 3,
  'Today-bullish (v_scan_verdict) stop = signal close - N x ATR14. Backtest 2026-09-29. Position sizing keeps atr_stop_multiple.')
on conflict (key) do nothing;

drop view public.v_scan_verdict;
drop view public.v_scan_pattern_stats;

drop function public.verdict_plan_levels(numeric, numeric, numeric, numeric);
create function public.verdict_plan_levels(p_close numeric, p_atr14 numeric, p_mult numeric)
returns table (entry_min numeric, entry_max numeric, stop_price numeric)
language plpgsql immutable as $$
declare
  c float8 := p_close::float8;
  emin float8 := floor(c * 0.97 * 100 + 0.5) / 100;
  emax float8 := floor(c * 1.03 * 100 + 0.5) / 100;
  ceiling float8 := floor(emin * 0.99 * 100 + 0.5) / 100;
  stop float8 := case when p_atr14 is not null and p_mult is not null
                      then c - p_mult::float8 * p_atr14::float8 end;
begin
  if stop is null or stop <= 0 then stop := emin * (1 - 0.08); end if;
  if stop > ceiling then stop := ceiling; end if;
  stop := floor(stop * 100 + 0.5) / 100;
  if stop >= emin then stop := floor((emin - 0.01) * 100 + 0.5) / 100; end if;
  return query select emin::numeric, emax::numeric, case when stop > 0 then stop::numeric end;
end $$;

create view public.v_scan_verdict as
with regime as (
  select round(100 * (x.adj / x.ma60 - 1), 2) as market_ma60_pct
  from (
    select p.trade_date, p.close * p.adj_factor as adj,
      avg(p.close * p.adj_factor) over w as ma60, count(*) over w as n
    from public.price_daily p
    where p.symbol = '0050' and p.close > 0
      and p.trade_date >= (select max(trade_date) from public.price_daily) - 150
    window w as (order by p.trade_date rows between 59 preceding and current row)
  ) x
  where x.n = 60
  order by x.trade_date desc
  limit 1
), cand as (
  select b.*, f.off_hi60,
    public.scan_supply_share(b.symbol, b.trade_date, b.close) as supply_share
  from public.v_breakout_scan b
  cross join lateral public.scan_pattern_features(b.symbol, b.trade_date) f
  where b.score_total >= 80
)
select c.*, r.market_ma60_pct
from cand c
cross join regime r
where c.off_hi60 > -5 and c.supply_share <= 0.10 and r.market_ma60_pct > 0
order by c.score_total desc, c.day_pct desc, c.symbol
limit 3;

comment on view public.v_scan_verdict is
  'Today-bullish R2p (2026-09-29): score>=80, within 5% of 60-day closing high, overhead supply <=10%, 0050 above MA60; top 3 by score, day_pct. Backtest: tools/scan-backtest/r2p.mjs.';

create or replace function public.freeze_verdict_watch() returns int
language plpgsql as $$
declare
  d date;
  mult numeric := (select value from public.app_settings where key = 'verdict_atr_stop_multiple');
  n int;
begin
  select max(trade_date) into d from public.v_breakout_scan;
  if d is null then return 0; end if;
  drop table if exists _v;
  create temp table _v on commit drop as select * from public.v_scan_verdict;
  delete from public.verdict_watch w where w.watch_date = d
    and not exists (select 1 from _v where _v.symbol = w.symbol);
  insert into public.verdict_watch as w (watch_date, symbol, name, signal_close, entry_min, entry_max, stop_price,
    supply_share, pattern, confidence, up10_pct, n10)
  select d, v.symbol, v.name, v.close, l.entry_min, l.entry_max, l.stop_price,
    v.supply_share, 'R2p', null, null, null
  from _v v cross join lateral public.verdict_plan_levels(v.close, v.atr14, mult) l
  on conflict (watch_date, symbol) do update set
    name = excluded.name, signal_close = excluded.signal_close, entry_min = excluded.entry_min,
    entry_max = excluded.entry_max, stop_price = excluded.stop_price, supply_share = excluded.supply_share,
    pattern = excluded.pattern, confidence = excluded.confidence, up10_pct = excluded.up10_pct,
    n10 = excluded.n10, frozen_at = now();
  get diagnostics n = row_count;
  return n;
end $$;
