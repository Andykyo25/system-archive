-- 移除 capital_flows,改回單一 initial_capital(2026-08-28,Andy 決定)
--
-- 背景:當天稍早為了處理「加碼入金讓 initial_capital 這個單一常數失效」而建了 capital_flows
-- + TWR 權益。Andy 實際用起來選擇更簡單的做法:**直接改 initial_capital 的金額**
-- (20.3004 → 28.8004 萬),不想多維護一張流水表。
--
-- 「已輸入入金後還是有警告」的原因查明:capital_flows **是空的**(0 列),
-- Andy 是直接改 initial_capital。加了 85,000 但最深那天缺 88,201,**還差 3,201**,
-- 所以 cash 仍是 −3,201、capital_incomplete 仍為 true。不是 bug。
--
-- 取捨(Andy 已知並選擇):把入金併進 initial_capital = 視同「這筆錢從第一天就在帳戶裡」,
-- 所以 2026-03~08 早期的報酬率會被**低估**(分母變大),peak/drawdown 的絕對值也會位移。
-- 換來的是零額外維護。對單人自用系統這是合理的取捨。
--
-- 保留 capital_incomplete 欄位:它現在是**唯一**會告訴 Andy「initial_capital 設得不夠」
-- 的機制 —— cash 算出負數只可能是本金給少了。
--
-- 注意:create or replace view **無法刪欄位**,所以必須 drop + create。
-- 已查 pg_depend:v_account_equity_daily 沒有任何 DB 端下游(只有 /performance 這個 app 讀者)。
--
-- rollback:重跑 20260828000001_capital_flows_and_twr_equity.sql

drop view if exists public.v_account_equity_daily;

create view public.v_account_equity_daily as
with cap as (
  select coalesce(max(value), 0) * 10000 as base
  from public.app_settings
  where key = 'initial_capital'
),
grid as (
  select p.trade_date
  from public.price_daily p
  where p.symbol = '0050' and p.close > 0
    and p.trade_date >= (select min(txn_date) from public.holdings_transactions)
),
pos as (
  select g.trade_date, t.symbol,
    sum(case when t.txn_type = 'BUY' then t.qty else -t.qty end) as qty
  from grid g
  join public.holdings_transactions t on t.txn_date <= g.trade_date
  group by g.trade_date, t.symbol
  having sum(case when t.txn_type = 'BUY' then t.qty else -t.qty end) > 0
),
mtm as (
  select p.trade_date,
    count(*) as position_count,
    count(*) filter (where mk.close is null) as missing_marks,
    coalesce(sum(p.qty::numeric * mk.close), 0) as market_value
  from pos p
  left join lateral (
    select pp.close from public.price_daily pp
    where pp.symbol = p.symbol and pp.close > 0 and pp.trade_date <= p.trade_date
    order by pp.trade_date desc limit 1
  ) mk on true
  group by p.trade_date
),
daily as (
  select g.trade_date,
    (select base from cap)
      + coalesce((select sum(case when t.txn_type = 'BUY'
                                  then (-(t.qty::numeric * t.price)) - coalesce(t.fee, 0)
                                  else t.qty::numeric * t.price - coalesce(t.fee, 0) - coalesce(t.tax, 0)
                             end)
                  from public.holdings_transactions t where t.txn_date <= g.trade_date), 0)
      + coalesce((select sum(d1.qty::numeric * (d1.sell_price - d1.buy_price)
                             - coalesce(d1.buy_fee, 0) - coalesce(d1.sell_fee, 0) - coalesce(d1.tax, 0))
                  from public.day_trades d1 where d1.trade_date <= g.trade_date), 0) as cash,
    coalesce(m.market_value, 0) as market_value,
    coalesce(m.position_count, 0) as position_count,
    coalesce(m.missing_marks, 0) = 0 as coverage_ok
  from grid g
  left join mtm m on m.trade_date = g.trade_date
)
select
  d.trade_date,
  round(d.cash, 0)                       as cash,
  round(d.market_value, 0)               as market_value,
  round(d.cash + d.market_value, 0)      as equity,
  d.position_count,
  d.coverage_ok,
  round(greatest((select base from cap),
        max(d.cash + d.market_value) filter (where d.coverage_ok)
          over (order by d.trade_date rows between unbounded preceding and current row)), 0) as peak_equity,
  case when d.coverage_ok then
    round(((d.cash + d.market_value) / nullif(greatest((select base from cap),
          max(d.cash + d.market_value) filter (where d.coverage_ok)
            over (order by d.trade_date rows between unbounded preceding and current row)), 0) - 1) * 100, 2)
  end                                    as drawdown_pct,
  (d.cash < 0)                           as capital_incomplete
from daily d
order by d.trade_date;

comment on view public.v_account_equity_daily is
  '每日 MTM 權益。capital_incomplete=true 代表現金算出負數 = app_settings.initial_capital '
  '設得比實際投入本金少(加碼入金後要把它加上去)。該列的報酬率與回撤不可引用。';

drop table if exists public.capital_flows;
