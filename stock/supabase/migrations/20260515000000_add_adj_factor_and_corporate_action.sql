-- Phase 0.1:還原權值地基 schema(2026-05-15 已 apply 到 DB via MCP migration 77)
-- 設計:price_daily 加單一 adj_factor 欄位(default 1.0 → 退版安全網:
--   全 1 時所有 view/EF 行為等於現狀)。adj_close = close × adj_factor。
-- 新表 stock_corporate_action 存 split + dividend(FinMind 兩免費表)。
--
-- 背景:price_daily 存未還原權值收盤價,0050 在 2025-06-18 做 1拆4
--   (188.65→47.16),backtest 算成假性 -75%,benchmark/alpha 全失真,
--   跨年 out-of-sample 無法驗 overfit。此 migration 是補還原權值的地基。

-- 1) price_daily 加 adj_factor(Postgres 11+ NOT NULL DEFAULT 是 metadata-only,
--    不 rewrite 大表,瞬間完成)
alter table public.price_daily
  add column if not exists adj_factor numeric not null default 1.0;

comment on column public.price_daily.adj_factor is
  'back-adjust 還原係數。adj_close = close * adj_factor。預設 1.0(未調整)。由 recompute_adj_factor() 依 stock_corporate_action 往回累乘計算。';

-- 2) corporate action 表(split + dividend),風格對齊既有 stock_* 表
create table if not exists public.stock_corporate_action (
  symbol        text        not null,
  action_date   date        not null,
  action_type   text        not null check (action_type in ('split','dividend')),
  before_price  numeric,
  after_price   numeric,
  ratio         numeric,    -- after_price / before_price(該日當天的調整係數)
  source        text        not null default 'finmind',
  fetched_at    timestamptz not null default now(),
  primary key (symbol, action_date, action_type)
);

comment on table public.stock_corporate_action is
  'FinMind TaiwanStockSplitPrice(分割)+ TaiwanStockDividendResult(除權息)結果。ratio = after/before,給 recompute_adj_factor() 往回累乘還原。';

create index if not exists idx_corp_action_symbol_date
  on public.stock_corporate_action (symbol, action_date);
