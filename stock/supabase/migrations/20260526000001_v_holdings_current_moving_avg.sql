-- 2026-05-26: v_holdings_current 改用「移動平均 + 全平倉重置」算 avg_cost
--
-- 起因(2026-05-26 Andy 親口):
--   2344 華邦電 2000 股 @ 139.5 進場,系統顯示 avg_cost 126.25 ≠ 139.5。
--
-- 根因(舊 view 算法):
--   avg_cost = SUM(buy_qty × buy_price) / SUM(buy_qty)
--   把出清前的舊批次也累積進來:
--   2344 5/7 BUY 2000@113 → 5/11 SELL 2000@114 → 5/26 BUY 2000@139.5
--   舊算 = (113×2000 + 139.5×2000) / 4000 = 126.25  ← 錯
--   正解 = 5/26 重新建倉的均價 139.5
--
-- 新算法(會計上的移動平均 + 全平倉重置):
--   時序走訪每筆 txn:
--     BUY  → total_cost += qty × price ; net_qty += qty
--     SELL 全平倉(qty >= net_qty) → reset:total_cost=0, net_qty=0
--     SELL 部分減倉 → 按當前均價沖銷:total_cost -= avg × sell_qty ; net_qty -= sell_qty
--     (部分減倉維持均價不變,符合會計慣例)
--   avg_cost = total_cost / net_qty
--
-- 下游影響:
--   v_holdings_advice / v_holdings_pnl / v_holdings_summary / v_fetch_universe_stocks
--   columns(symbol/net_qty/avg_cost/total_cost)結構不變 → CREATE OR REPLACE 安全
--   只 BUY 沒 SELL 過的持股 → 新舊算法結果完全一致(回歸測試)
--
-- 驗證(2026-05-26 跑出來):
--   2344 new_avg=139.50 (was 126.25) ✓
--   2344 new_total=279000 (was 252500) ✓ = 2000×139.5

create or replace view v_holdings_current as
with recursive ord as (
  select
    id, symbol, txn_type, qty, price, txn_date, created_at,
    row_number() over (partition by symbol order by txn_date, created_at) as rn
  from holdings_transactions
),
walk as (
  -- 起始 row(每 symbol 第 1 筆)
  select
    symbol, rn,
    case when txn_type = 'BUY' then qty else 0 end as net_qty,
    case when txn_type = 'BUY' then qty::numeric * price else 0::numeric end as total_cost
  from ord
  where rn = 1
  union all
  -- 遞迴累加
  select
    t.symbol, t.rn,
    case
      when t.txn_type = 'BUY' then w.net_qty + t.qty
      when t.txn_type = 'SELL' and t.qty >= w.net_qty then 0
      else w.net_qty - t.qty
    end as net_qty,
    case
      when t.txn_type = 'BUY' then w.total_cost + t.qty::numeric * t.price
      when t.txn_type = 'SELL' and t.qty >= w.net_qty then 0::numeric
      else w.total_cost - (w.total_cost / nullif(w.net_qty, 0)) * t.qty
    end as total_cost
  from ord t
  join walk w on w.symbol = t.symbol and w.rn + 1 = t.rn
),
final as (
  select distinct on (symbol)
    symbol, net_qty, total_cost
  from walk
  order by symbol, rn desc
)
select
  symbol,
  net_qty,
  case when net_qty > 0 then total_cost / net_qty else 0 end as avg_cost,
  total_cost
from final
where net_qty > 0;
