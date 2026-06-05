-- 2026-06-05: v_equity_curve — 階梯式權益曲線(每筆平倉落袋後帳戶權益時間序列)
--
-- 需求:把「本金 → 逐筆平倉跳升 → 現值」做成內建線圖(/performance 頁)。
-- 口徑:階梯式,平倉才跳升,不含持股期間未實現浮動(資料 100% 靠交易記錄,
--       不依賴 price_daily 每日價 — 因 009816 ETF / 6285 末段缺每日價)。
--
-- 權益變化(成本基礎,終點精準對齊真實交割現金):
--   BUY  → delta = -fee
--          (現金 -(qty×price+fee),進貨成本 +qty×price 入帳 → 淨 = -手續費)
--   SELL → delta = +realized_pnl
--          (v_holdings_realized 已算 (price-avg_cost)×qty-fee-tax,不含買費)
--   equity(t) = initial_capital + running_sum(delta)
--   終點 = 203,004 - Σ買費(1,184) + Σ帳面 realized(205,680) = 407,500 ✓
--
-- initial_capital 存 app_settings(萬單位,沿用 budget_ntd 繞 numeric(10,6) 整數僅 4 位)。

-- (a) 初始本金設定(萬單位:20.3004 萬 = 203,004 元,反推本金,可在 /settings 改)
insert into public.app_settings(key, value, description)
values ('initial_capital', 20.3004, '初始本金(單位:萬 NT$)— 權益曲線起點')
on conflict (key) do nothing;

-- (b) 階梯式權益曲線 view
create or replace view public.v_equity_curve as
with events as (
  select
    txn_date    as event_date,
    created_at,
    symbol,
    'BUY'       as event_type,
    qty,
    price,
    -coalesce(fee, 0)::numeric as delta,
    null::numeric              as realized_pnl
  from public.holdings_transactions
  where txn_type = 'BUY'
  union all
  select
    sell_date    as event_date,
    created_at,
    symbol,
    'SELL'       as event_type,
    qty_sold     as qty,
    sell_price   as price,
    realized_pnl as delta,
    realized_pnl
  from public.v_holdings_realized
),
cap as (
  select coalesce(max(value), 0) * 10000 as base
  from public.app_settings
  where key = 'initial_capital'
)
select
  e.event_date,
  e.created_at,
  e.symbol,
  e.event_type,
  e.qty,
  e.price,
  e.delta,
  e.realized_pnl,
  (select base from cap)
    + sum(e.delta) over (
        order by e.event_date, e.created_at
        rows between unbounded preceding and current row
      ) as equity
from events e
order by e.event_date, e.created_at;
