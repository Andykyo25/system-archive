-- v_account_equity_daily(2026-08-17):每交易日 mark-to-market 帳戶權益。
--
-- 動機:既有 v_equity_curve 是「階梯式」— 只在平倉事件跳動,持股期間曲線是平的
-- (BUY 只扣手續費、不含未實現浮動)。因此它算出來的最大回撤是假的:只反映已實現虧損,
-- 完全看不到抱單期間的帳面回撤。實例:2408 從 6 月高點 505 跌到 07-30 低點 322(−36.2%),
-- 階梯曲線上是一條平線。
--
-- 這條 view 補的就是那段:每個交易日 cash + 未平倉市值,回撤/峰值才有意義。
-- 兩條並存、各司其職:v_equity_curve = 落袋節奏,v_account_equity_daily = 風險曲線。
--
-- 為什麼是 derived view 不是實體表 + cron:所有輸入(initial_capital / holdings_transactions
-- / day_trades / price_daily)都已存在 → 可直接回算全段歷史;實體表 + cron 只能從今天起
-- 累積(歷史歸零),而且多一個會安靜死掉的 cron(同 scan_picks 表註解的理由)。
--
-- coverage_ok(L45 不偽造):009816 在 2026-03-03~04-29 持有期間 price_daily 零筆
-- (該檔首筆 bar 是 2026-07-30)→ 那段無法 MTM。不用成本價假裝,標 coverage_ok=false,
-- peak/drawdown 的 window 只走 coverage_ok 列。
--
-- 口徑:market_value 用「原始收盤價」(close,非 close×adj_factor)— 持有的是實際股數,
-- 標記價要是當天真的能成交的價;adj_factor 是給報酬序列連續性用的,不是市值。
--
-- rollback:drop view public.v_account_equity_daily;(全新物件,零下游依賴)
create or replace view public.v_account_equity_daily as
with cap as (
  select coalesce(max(value), 0) * 10000 as base
    from app_settings
   where key = 'initial_capital'
),
grid as (
  -- 交易日曆用 0050(benchmark,覆蓋最完整)
  select p.trade_date
    from price_daily p
   where p.symbol = '0050'
     and p.close > 0
     and p.trade_date >= (select min(txn_date) from holdings_transactions)
),
pos as (
  -- 每個交易日的未平倉部位
  select g.trade_date, t.symbol,
         sum(case when t.txn_type = 'BUY' then t.qty else -t.qty end) as qty
    from grid g
    join holdings_transactions t on t.txn_date <= g.trade_date
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
      select pp.close
        from price_daily pp
       where pp.symbol = p.symbol
         and pp.close > 0
         and pp.trade_date <= p.trade_date
       order by pp.trade_date desc
       limit 1
    ) mk on true
   group by p.trade_date
),
daily as (
  select g.trade_date,
         -- 現金 = 本金 + 累計買賣現金流(含費稅)+ 累計當沖損益
         (select cap.base from cap)
         + coalesce((select sum(case when t.txn_type = 'BUY'
                                     then -(t.qty::numeric * t.price) - coalesce(t.fee, 0)
                                     else  (t.qty::numeric * t.price) - coalesce(t.fee, 0) - coalesce(t.tax, 0)
                                end)
                       from holdings_transactions t
                      where t.txn_date <= g.trade_date), 0)
         + coalesce((select sum(d.qty::numeric * (d.sell_price - d.buy_price)
                                - coalesce(d.buy_fee, 0) - coalesce(d.sell_fee, 0) - coalesce(d.tax, 0))
                       from day_trades d
                      where d.trade_date <= g.trade_date), 0) as cash,
         coalesce(m.market_value, 0) as market_value,
         coalesce(m.position_count, 0) as position_count,
         coalesce(m.missing_marks, 0) = 0 as coverage_ok
    from grid g
    left join mtm m on m.trade_date = g.trade_date
)
select d.trade_date,
       round(d.cash, 0) as cash,
       round(d.market_value, 0) as market_value,
       round(d.cash + d.market_value, 0) as equity,
       d.position_count,
       d.coverage_ok,
       round(greatest(
         (select cap.base from cap),
         max(d.cash + d.market_value) filter (where d.coverage_ok)
           over (order by d.trade_date rows between unbounded preceding and current row)
       ), 0) as peak_equity,
       case when d.coverage_ok then
         round((
           (d.cash + d.market_value) / nullif(greatest(
             (select cap.base from cap),
             max(d.cash + d.market_value) filter (where d.coverage_ok)
               over (order by d.trade_date rows between unbounded preceding and current row)
           ), 0) - 1
         ) * 100, 2)
       end as drawdown_pct
  from daily d
 order by d.trade_date;
