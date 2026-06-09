-- 2026-06-09: 現股當沖(day trade)支援 — 獨立 day_trades 表
--
-- 起因:當沖(同日買賣沖銷)損益 =(賣-買)×股數-費稅,不影響原持股成本。
--   系統移動平均成本法無法表達「賠錢又不動持股」(賣會被當成賣掉持股算錯成本)
--   → 用獨立表完全隔離,不碰 v_holdings_realized / v_holdings_current 的遞迴邏輯
--   (L37/L42:不破壞已修好的核心)。損益再用加法 union 進彙總/曲線/明細。

create table public.day_trades (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  trade_date date not null default current_date,
  qty integer not null check (qty > 0),
  buy_price numeric(12,4) not null,
  sell_price numeric(12,4) not null,
  buy_fee numeric(10,2) not null default 0,
  sell_fee numeric(10,2) not null default 0,
  tax numeric(10,2) not null default 0,
  note text,
  created_at timestamptz not null default now()
);
create index idx_day_trades_date on public.day_trades(trade_date);
alter table public.day_trades enable row level security;  -- 對齊全表 deny-all(service_role 全寫)

-- 當沖已實現損益 view(欄位對齊 v_holdings_realized 以便 union + is_day_trade 旗標)
create or replace view public.v_day_trades_realized as
select
  id          as txn_id,
  symbol,
  trade_date  as sell_date,
  qty         as qty_sold,
  sell_price,
  buy_price   as avg_cost_at_sell,                       -- 當沖「成本」= 買回價
  (sell_price - buy_price) * qty::numeric - buy_fee - sell_fee - tax as realized_pnl,
  case when buy_price > 0
       then (sell_price - buy_price) / buy_price * 100::numeric
       else null::numeric end as realized_pct,
  (buy_fee + sell_fee) as fee,
  tax,
  note,
  created_at,
  true        as is_day_trade
from public.day_trades;

-- 當沖證交稅率(台股現行減半 0.15%,可在 /settings 調)
insert into public.app_settings(key, value, description) values
  ('day_trade_tax_stock', 0.0015, '現股當沖證交稅 0.15%(減半)'),
  ('day_trade_tax_etf',   0.0005, 'ETF 當沖證交稅 0.05%')
on conflict (key) do nothing;
