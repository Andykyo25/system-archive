-- v_trade_behavior v2(2026-07-03):買入質量 + 回追偵測 + position-aware 持有天數
--
-- 動機:7/01-7/02 兩筆虧損(2408 −8.15%、3236 −6.89%)實證型態 =「買在追高區」
--   (dev MA20 +19.6%/+16.9%,20日已漲 +53%/+33%),且 2408 是賣飛 6 天內更高價買回。
--   對照贏單全部買在回檔/低基期 → 行為分析必須讓「買入質量」現形。
--
-- v1 → v2 改動:
--   1. holding_days 修正為 position-aware:v1 用「首次 BUY ≤ 賣出日」,平倉再開倉會
--      算到舊倉(2408 7/01 賣顯示 58 天,實際 6/25 開倉只 6 天)。v2 用「開倉買進日」
--      = 買進前 net_qty=0 的 BUY(移動平均制的自然開倉點)。
--   2. append 6 欄(L37 append-only,既有欄名/型別/順序不動):
--      entry_date / entry_price(開倉日與成交價)
--      dev_ma20_at_buy(開倉日收盤 vs MA20 偏離%;adj 口徑一致,用收盤非成交價)
--      ret20d_at_buy(開倉日往前 20 交易日漲幅%)
--      is_chase_buy(dev>+10% = v_entry_quality chase 同門檻;<20 樣本日 null)
--      is_reentry_buy(開倉前 10 日曆天內同檔有 SELL 且開倉價 > 賣價 = 賣飛回追)
--
-- 誠實 caveat:day_trades(當沖)不在此 view(獨立表);dev 用收盤算,實際盤中
--   成交價可能更高(3236 付 75.5 vs 收盤 73)→ 追高判定偏保守。

create or replace view public.v_trade_behavior as
with txn_flow as (
  select symbol, txn_type, qty, price, txn_date, created_at,
    sum(case when txn_type = 'BUY' then qty else -qty end)
      over (partition by symbol order by txn_date, created_at
            rows between unbounded preceding and current row) as net_after
  from public.holdings_transactions
),
opening_buys as (
  -- 開倉買:此筆 BUY 之前 net=0(net_after − qty = 0)
  select symbol, txn_date as entry_date, price as entry_price, created_at
  from txn_flow
  where txn_type = 'BUY' and net_after = qty
),
base as (
  select
    v.txn_id, v.symbol, v.sell_date, v.qty_sold, v.sell_price,
    v.realized_pnl, v.realized_pct,
    (v.realized_pnl > 0) as is_win,
    ob.entry_date, ob.entry_price,
    least((
      select count(*) from public.price_daily p
      where p.symbol = v.symbol and p.trade_date > v.sell_date
    ), 20) as fwd_days_available,
    (
      select p.close from public.price_daily p
      where p.symbol = v.symbol and p.trade_date > v.sell_date
      order by p.trade_date offset 19 limit 1
    ) as fwd_20d_close,
    (
      select max(w.close) from (
        select pp.close from public.price_daily pp
        where pp.symbol = v.symbol and pp.trade_date > v.sell_date
        order by pp.trade_date limit 20
      ) w
    ) as fwd_max20_close,
    -- 開倉日收盤(adj)
    (
      select p.close * coalesce(p.adj_factor, 1) from public.price_daily p
      where p.symbol = v.symbol and p.trade_date <= ob.entry_date and p.close > 0
      order by p.trade_date desc limit 1
    ) as close_at_buy,
    -- 開倉日 MA20(近 20 個交易日收盤 adj 平均;不足 20 日 → null gate)
    (
      select case when count(*) >= 20 then avg(w.ac) end from (
        select pp.close * coalesce(pp.adj_factor, 1) as ac from public.price_daily pp
        where pp.symbol = v.symbol and pp.trade_date <= ob.entry_date and pp.close > 0
        order by pp.trade_date desc limit 20
      ) w
    ) as ma20_at_buy,
    -- 開倉日往前第 20 個交易日收盤(算 ret20d)
    (
      select p.close * coalesce(p.adj_factor, 1) from public.price_daily p
      where p.symbol = v.symbol and p.trade_date <= ob.entry_date and p.close > 0
      order by p.trade_date desc offset 20 limit 1
    ) as close_20d_before_buy,
    -- 賣飛回追:開倉前 10 日曆天內同檔 SELL 且開倉價 > 該賣價
    exists (
      select 1 from public.holdings_transactions s
      where s.symbol = v.symbol and s.txn_type = 'SELL'
        and s.txn_date >= ob.entry_date - 10 and s.txn_date < ob.entry_date
        and s.price < ob.entry_price
    ) as is_reentry_buy
  from public.v_holdings_realized v
  left join lateral (
    select o.entry_date, o.entry_price, o.created_at from opening_buys o
    where o.symbol = v.symbol and o.entry_date <= v.sell_date
    order by o.entry_date desc, o.created_at desc limit 1
  ) ob on true
)
select
  base.txn_id,
  base.symbol,
  base.sell_date,
  base.qty_sold,
  base.realized_pnl,
  base.realized_pct,
  base.is_win,
  (base.sell_date - base.entry_date) as holding_days,
  base.fwd_days_available,
  case when base.fwd_20d_close is not null and base.sell_price > 0
       then round((base.fwd_20d_close / base.sell_price - 1) * 100, 2)
  end as fwd_20d_pct,
  case when base.fwd_max20_close is not null and base.sell_price > 0
       then round((base.fwd_max20_close / base.sell_price - 1) * 100, 2)
  end as fwd_max20_pct,
  -- v2 append(買入質量)
  base.entry_date,
  base.entry_price,
  case when base.ma20_at_buy > 0
       then round((base.close_at_buy / base.ma20_at_buy - 1) * 100, 2)
  end as dev_ma20_at_buy,
  case when base.close_20d_before_buy > 0
       then round((base.close_at_buy / base.close_20d_before_buy - 1) * 100, 2)
  end as ret20d_at_buy,
  case when base.ma20_at_buy > 0
       then (base.close_at_buy / base.ma20_at_buy - 1) * 100 > 10
  end as is_chase_buy,
  base.is_reentry_buy
from base;

comment on view public.v_trade_behavior is
  'B1v2 交易行為分析:平倉 + position-aware 持有天數 + 賣後20日走勢(賣太早)+ 買入質量(dev MA20/追高/回追)。';
