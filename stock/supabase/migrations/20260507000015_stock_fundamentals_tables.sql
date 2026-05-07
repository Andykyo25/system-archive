-- M3.6:基本面資料層
-- stock_fundamentals_quarterly:每季財報(從 FinMind 季報 datasets pivot 而來)
-- stock_pe_pb_daily:每日 PE/PB/殖利率(從 FinMind TaiwanStockPER)

create table public.stock_fundamentals_quarterly (
  symbol text not null,
  period_end date not null,           -- 財報期間結束日(e.g. 2025-12-31 = Q4)
  eps numeric(12,4),                   -- 基本每股盈餘
  net_income numeric(20,0),            -- 本期淨利(歸屬母公司)
  revenue numeric(20,0),               -- 營業收入
  gross_profit numeric(20,0),          -- 營業毛利
  operating_income numeric(20,0),      -- 營業利益
  total_equity numeric(20,0),          -- 歸屬母公司權益(算 ROE 用)
  total_assets numeric(20,0),
  total_liabilities numeric(20,0),
  ocf numeric(20,0),                   -- 營業活動現金流
  ic numeric(20,0),                    -- 投資活動現金流(通常為負)
  fcf numeric(20,0),                   -- 自由現金流近似 = OCF + IC
  fetched_at timestamptz not null default now(),
  primary key (symbol, period_end)
);
create index idx_stock_fundamentals_period on public.stock_fundamentals_quarterly (period_end desc);
alter table public.stock_fundamentals_quarterly enable row level security;

create table public.stock_pe_pb_daily (
  symbol text not null,
  trade_date date not null,
  pe numeric(10,4),                    -- 本益比
  pb numeric(10,4),                    -- 股價淨值比
  dividend_yield numeric(8,4),         -- 殖利率(%)
  fetched_at timestamptz not null default now(),
  primary key (symbol, trade_date)
);
create index idx_stock_pe_pb_date on public.stock_pe_pb_daily (trade_date desc);
alter table public.stock_pe_pb_daily enable row level security;
