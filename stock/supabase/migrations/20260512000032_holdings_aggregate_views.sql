-- M8.5: 持股 aggregate views
--
-- v_holdings_current:目前持有部位(net_qty > 0),平均成本法
-- v_holdings_realized:每筆 SELL 對應的已實現損益
-- v_holdings_summary:累計總計(已實現 + 未實現 + 投入 + 回收)
--
-- 平均成本法說明:
-- - avg_cost = 累計 BUY 金額 / 累計 BUY 股數(不看 SELL,SELL 不會改變剩餘股數的平均成本)
-- - 等於台灣券商「移動加權平均」的算法
-- - 不做 FIFO(FIFO 計算複雜度高,且台股稅務沒分先進先出)
-- - 已實現損益用「賣出當下的累計 BUY 加權平均」作為成本

create or replace view public.v_holdings_current as
with txn as (
  select
    symbol,
    sum(case when txn_type = 'BUY'  then qty else 0 end) as buy_qty,
    sum(case when txn_type = 'SELL' then qty else 0 end) as sell_qty,
    sum(case when txn_type = 'BUY'  then qty * price else 0 end) as buy_amount
  from public.holdings_transactions
  group by symbol
)
select
  symbol,
  buy_qty - sell_qty as net_qty,
  case when buy_qty > 0 then buy_amount / buy_qty else 0 end as avg_cost,
  case when buy_qty > 0 then (buy_amount / buy_qty) * (buy_qty - sell_qty) else 0 end as total_cost
from txn
where buy_qty - sell_qty > 0;

-- v_holdings_realized:每筆 SELL 對應一行,顯示當下平均成本 + 實現損益
-- avg_cost_at_sell 用 window function 算「截至此 SELL 之前的累計 BUY 加權平均」
create or replace view public.v_holdings_realized as
with all_txn as (
  select
    id,
    symbol,
    txn_type,
    qty,
    price,
    fee,
    tax,
    txn_date,
    created_at,
    note,
    -- 截至(且包含)當前 row 的累計 BUY 金額 / 股數
    -- order by (txn_date, created_at) 確保同日多筆能穩定排序
    sum(case when txn_type = 'BUY' then qty * price else 0 end)
      over (partition by symbol order by txn_date, created_at
            rows between unbounded preceding and current row) as cum_buy_amount,
    sum(case when txn_type = 'BUY' then qty else 0 end)
      over (partition by symbol order by txn_date, created_at
            rows between unbounded preceding and current row) as cum_buy_qty
  from public.holdings_transactions
)
select
  id as txn_id,
  symbol,
  txn_date as sell_date,
  qty as qty_sold,
  price as sell_price,
  case when cum_buy_qty > 0 then cum_buy_amount / cum_buy_qty else 0 end as avg_cost_at_sell,
  -- realized_pnl = (sell_price - avg_cost) * qty - fee - tax
  (price - case when cum_buy_qty > 0 then cum_buy_amount / cum_buy_qty else 0 end) * qty
    - fee - tax as realized_pnl,
  -- realized_pct 以「成本基數」計算: (sell - avg) / avg * 100
  case when cum_buy_qty > 0 and cum_buy_amount > 0
    then ((price - cum_buy_amount / cum_buy_qty)
          / (cum_buy_amount / cum_buy_qty)) * 100
  end as realized_pct,
  fee,
  tax,
  note,
  created_at
from all_txn
where txn_type = 'SELL';

-- v_holdings_summary:全部彙總
-- total_realized_pnl  = sum(realized_pnl)
-- total_unrealized_pnl = sum 目前持股 (current_price - avg_cost) * net_qty
-- total_invested      = sum 所有 BUY 的 qty * price + fee
-- total_recovered     = sum 所有 SELL 的 qty * price - fee - tax(實得回收)
-- count_holdings      = 目前持有檔數
-- count_closed        = 已全部賣光(曾持有但 net_qty 現在 = 0)的檔數
create or replace view public.v_holdings_summary as
with txn_agg as (
  select
    symbol,
    sum(case when txn_type = 'BUY'  then qty else 0 end) as buy_qty,
    sum(case when txn_type = 'SELL' then qty else 0 end) as sell_qty,
    sum(case when txn_type = 'BUY'  then qty * price + fee else 0 end) as invested,
    sum(case when txn_type = 'SELL' then qty * price - fee - tax else 0 end) as recovered
  from public.holdings_transactions
  group by symbol
),
realized as (
  select coalesce(sum(realized_pnl), 0) as total_realized_pnl
  from public.v_holdings_realized
),
unrealized as (
  -- (M8.3 同步)未實現用 realtime 現價算,不再用 v_latest_price 的昨日收盤
  select
    coalesce(sum(
      case when lp.current_price is not null
        then (lp.current_price - c.avg_cost) * c.net_qty
      end
    ), 0) as total_unrealized_pnl
  from public.v_holdings_current c
  left join public.v_latest_price_realtime lp on lp.symbol = c.symbol
)
select
  (select total_realized_pnl from realized) as total_realized_pnl,
  (select total_unrealized_pnl from unrealized) as total_unrealized_pnl,
  (select total_realized_pnl from realized) + (select total_unrealized_pnl from unrealized) as total_pnl,
  coalesce((select sum(invested) from txn_agg), 0) as total_invested,
  coalesce((select sum(recovered) from txn_agg), 0) as total_recovered,
  (select count(*) from public.v_holdings_current) as count_holdings,
  -- count_closed:有 BUY 也有 SELL 且 net_qty = 0 → 已平倉
  coalesce((
    select count(*) from txn_agg
    where buy_qty > 0 and buy_qty - sell_qty = 0
  ), 0) as count_closed;
