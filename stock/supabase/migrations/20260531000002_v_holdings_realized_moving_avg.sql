-- 2026-05-31: v_holdings_realized 改用移動平均 + 全平倉重置(A1,同根漏修)
--
-- 起因(全系統審查 A1):
--   上週修 v_holdings_current(20260526000001)用遞迴移動平均 + 全平倉 reset,
--   但 v_holdings_realized 仍用舊算法 cum_buy_amount / cum_buy_qty
--   (ROWS UNBOUNDED PRECEDING,涵蓋全部歷史 BUY,永不 reset)當 avg_cost_at_sell。
--   → 同根 bug 漏修。
--
-- 影響:
--   v_holdings_realized.realized_pnl 是 v_holdings_summary.total_realized_pnl 唯一來源。
--   對「平倉後再建倉再賣」的標的會用錯成本 → 虛報已實現損益(誤導交易/報稅)。
--
-- 2344 實例:BUY 2000@113 → SELL 2000@114(全平倉) → BUY 2000@139.5
--   現有那筆 5/11 SELL:舊算 avg=113(碰巧對,發生在重置前)→ 修後仍 113 ✓
--   未來若再賣:舊算 avg=(113×2000+139.5×2000)/4000=126.25 ❌
--               修後 avg=139.5 ✓(部位已重置,只剩 5/26 那批)
--
-- 新算法(與 v_holdings_current 同一套遞迴):
--   時序走訪每筆 txn,維護 (net_qty, total_cost):
--     BUY  → total_cost += qty×price ; net_qty += qty
--     SELL → avg_cost_at_sell = 賣出前的 total_cost / net_qty(移動均價)
--            realized_pnl = (sell_price - avg_cost_at_sell)×qty - fee - tax
--            扣減:全平倉(qty≥net)→ reset 0/0;部分減倉 → 按均價沖銷(維持均價)
--
-- 欄位/型別與舊版一致(txn_id/symbol/sell_date/qty_sold/sell_price/avg_cost_at_sell/
--   realized_pnl/realized_pct/fee/tax/note/created_at)→ CREATE OR REPLACE 安全。

create or replace view v_holdings_realized as
with recursive ord as (
  select
    id, symbol, txn_type, qty, price, fee, tax, txn_date, note, created_at,
    row_number() over (partition by symbol order by txn_date, created_at) as rn
  from holdings_transactions
),
walk as (
  -- 起始 row(每 symbol 第 1 筆)
  select
    o.id as txn_id, o.symbol, o.rn, o.txn_type, o.qty, o.price, o.fee, o.tax,
    o.txn_date, o.note, o.created_at,
    (case when o.txn_type = 'BUY' then o.qty else 0 end)::bigint as net_qty_after,
    case when o.txn_type = 'BUY' then o.qty::numeric * o.price else 0::numeric end as total_cost_after,
    -- 第一筆若是 SELL(異常:無對應 BUY),avg 設 null
    null::numeric as avg_cost_at_sell
  from ord o
  where o.rn = 1
  union all
  -- 遞迴
  select
    o.id, o.symbol, o.rn, o.txn_type, o.qty, o.price, o.fee, o.tax,
    o.txn_date, o.note, o.created_at,
    (case
      when o.txn_type = 'BUY' then w.net_qty_after + o.qty
      when o.txn_type = 'SELL' and o.qty >= w.net_qty_after then 0
      else w.net_qty_after - o.qty
    end)::bigint as net_qty_after,
    case
      when o.txn_type = 'BUY' then w.total_cost_after + o.qty::numeric * o.price
      when o.txn_type = 'SELL' and o.qty >= w.net_qty_after then 0::numeric
      else w.total_cost_after - (w.total_cost_after / nullif(w.net_qty_after, 0)) * o.qty
    end as total_cost_after,
    -- avg_cost_at_sell = 賣出「前」的移動均價(用上一狀態 w 的 net/total)
    case
      when o.txn_type = 'SELL' and w.net_qty_after > 0
      then w.total_cost_after / w.net_qty_after
      else null::numeric
    end as avg_cost_at_sell
  from ord o
  join walk w on w.symbol = o.symbol and w.rn + 1 = o.rn
)
select
  txn_id,
  symbol,
  txn_date as sell_date,
  qty as qty_sold,
  price as sell_price,
  avg_cost_at_sell,
  (price - coalesce(avg_cost_at_sell, 0::numeric)) * qty::numeric - fee - tax as realized_pnl,
  case
    when avg_cost_at_sell is not null and avg_cost_at_sell > 0
    then (price - avg_cost_at_sell) / avg_cost_at_sell * 100::numeric
    else null::numeric
  end as realized_pct,
  fee,
  tax,
  note,
  created_at
from walk
where txn_type = 'SELL';
