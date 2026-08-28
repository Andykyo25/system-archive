-- capital_incomplete 改判「四捨五入後的現金」(2026-08-28)
--
-- 問題:Andy 依 /performance 的提示把 initial_capital 設到 29.1205 萬(291,205)後,
-- 警告仍不消失。查出真實 min(cash) = **−0.110000** —— 只差 0.11 元。
--
-- 根因(同 [[L67]] 家族:判斷用的數字與顯示用的數字不是同一個):
-- view 輸出的 cash 欄位是 `round(d.cash, 0)`,但 capital_incomplete 判斷的是
-- **未四捨五入的原值**。畫面顯示 cash = 0(看起來已打平),旗標卻仍為 true。
-- 而我先前算給 Andy 的「至少要設到 29.1205 萬」也是拿 round 過的欄位算的,所以差那 0.11。
--
-- 修法:capital_incomplete 改判 `round(d.cash, 0) < 0`,與畫面顯示的欄位同一個數字。
-- 0.11 元是零頭雜訊,不是「本金設得不夠」;真正缺本金時金額是萬元級,不會被 round 蓋掉。
--
-- verify: incomplete_days 3 → 0;min(cash) = 0;權益 597,000;最大回撤 −25.92%
-- rollback: 把最後一個欄位的條件改回 (d.cash < 0),其餘不動

create or replace view public.v_account_equity_daily as
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
  -- ⬇ 本次唯一改動:原為 (d.cash < 0),與上面顯示用的 round(d.cash,0) 口徑不一致
  (round(d.cash, 0) < 0)                 as capital_incomplete
from daily d
order by d.trade_date;

comment on view public.v_account_equity_daily is
  '每日 MTM 權益。capital_incomplete=true 代表現金**四捨五入後**為負 = '
  'app_settings.initial_capital 設得比實際投入本金少(加碼入金後要把它加上去)。'
  '刻意判 round 後的值,與 cash 欄位一致 —— 判原值會把 0.11 元的零頭當成缺本金。';
