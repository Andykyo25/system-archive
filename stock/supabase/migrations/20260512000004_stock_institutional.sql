-- M8: 法人三大買賣超(FinMind TaiwanStockInstitutionalInvestorsBuySell)
--
-- FinMind 回傳 long format(每 (date, stock_id) 多筆,每筆對應一種法人 name):
--   name ∈ Foreign_Investor / Foreign_Dealer_Self / Investment_Trust / Dealer_self / Dealer_Hedging
-- 我們在 Edge Function 內 pivot 成 wide format,每 (symbol, trade_date) 一筆,內含 net_*
--
-- 主要分析欄位 net_foreign / net_invest_trust / net_dealer 是三大法人的 net buy/sell

create table if not exists public.stock_institutional (
  symbol text not null,
  trade_date date not null,
  foreign_buy bigint,
  foreign_sell bigint,
  foreign_net bigint,                  -- foreign_buy - foreign_sell
  invest_trust_buy bigint,
  invest_trust_sell bigint,
  invest_trust_net bigint,
  dealer_self_buy bigint,
  dealer_self_sell bigint,
  dealer_self_net bigint,
  dealer_hedging_buy bigint,
  dealer_hedging_sell bigint,
  dealer_hedging_net bigint,
  three_major_net bigint,              -- foreign_net + invest_trust_net + (dealer_self_net + dealer_hedging_net)
  fetched_at timestamptz not null default now(),
  primary key (symbol, trade_date)
);
create index if not exists idx_inst_recent on public.stock_institutional (trade_date desc);
create index if not exists idx_inst_symbol_recent on public.stock_institutional (symbol, trade_date desc);
-- partial index for 「最近大買」screening
create index if not exists idx_inst_foreign_big_buy on public.stock_institutional (symbol, trade_date)
  where foreign_net > 0;

alter table public.stock_institutional enable row level security;
