-- M8: 融資融券餘額(FinMind TaiwanStockMarginPurchaseShortSale)
--
-- 從 FinMind 抓回的欄位完整對應(單位:張,1 張 = 1000 股):
--   MarginPurchaseBuy/Sell/CashRepayment/TodayBalance/YesterdayBalance/Limit
--   ShortSaleBuy/Sell/CashRepayment/TodayBalance/YesterdayBalance/Limit
--   OffsetLoanAndShort  (資券相抵)
--
-- 我們主要關心:
--   margin_balance(今日融資餘額)、short_balance(今日融券餘額)
--   margin_delta / short_delta(餘額日變化 = today - yesterday)
--   reverse signal:融資減 + 股價漲 = 散戶離場(健康);融券減 = 空單回補

create table if not exists public.stock_margin (
  symbol text not null,
  trade_date date not null,
  margin_buy bigint,                   -- 當日融資買進(張)
  margin_sell bigint,                  -- 當日融資賣出
  margin_cash_repay bigint,            -- 現金償還
  margin_balance bigint,               -- 今日融資餘額(張)
  margin_balance_prev bigint,          -- 昨日融資餘額
  margin_delta bigint,                 -- balance - prev
  margin_limit bigint,                 -- 融資限額
  short_sell bigint,                   -- 當日融券賣出
  short_buy bigint,                    -- 當日融券回補
  short_cash_repay bigint,
  short_balance bigint,                -- 今日融券餘額
  short_balance_prev bigint,
  short_delta bigint,
  short_limit bigint,
  offset_loan_and_short bigint,        -- 資券相抵
  fetched_at timestamptz not null default now(),
  primary key (symbol, trade_date)
);
create index if not exists idx_margin_recent on public.stock_margin (trade_date desc);
create index if not exists idx_margin_symbol_recent on public.stock_margin (symbol, trade_date desc);
-- partial index 加速「融資餘額連減」與「融券回補」 screening
create index if not exists idx_margin_balance_dropping on public.stock_margin (symbol, trade_date)
  where margin_delta < 0;
create index if not exists idx_short_balance_dropping on public.stock_margin (symbol, trade_date)
  where short_delta < 0;

alter table public.stock_margin enable row level security;
