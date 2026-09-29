-- v_scan_verdict 效能修正(2026-09-29,接 20260929000001)
-- 問題:加上 ORDER BY ... LIMIT 3 後,planner 先對 v_breakout_scan 全部約 900 檔跑逐檔函式
--   (scan_pattern_features / scan_supply_share)再過濾 score ≥ 80 → 11.2 秒,超過 PostgREST 8 秒上限,線上 /scan 載入失敗。
-- 修法:score ≥ 80 先做成 MATERIALIZED CTE,函式只跑約 20 檔 → 4.1 秒(與舊版看多 4.4 秒同級)。欄位與順序不變。
-- rollback:重跑 20260929000001 的 v_scan_verdict 定義(功能相同,只是慢)。

create or replace view public.v_scan_verdict as
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
), base as materialized (
  select * from public.v_breakout_scan where score_total >= 80
), cand as (
  select b.*, f.off_hi60,
    public.scan_supply_share(b.symbol, b.trade_date, b.close) as supply_share
  from base b
  cross join lateral public.scan_pattern_features(b.symbol, b.trade_date) f
)
select c.*, r.market_ma60_pct
from cand c
cross join regime r
where c.off_hi60 > -5 and c.supply_share <= 0.10 and r.market_ma60_pct > 0
order by c.score_total desc, c.day_pct desc, c.symbol
limit 3;
