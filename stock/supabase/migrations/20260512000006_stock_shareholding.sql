-- M8: 集保戶數 / 大戶持股(FinMind TaiwanStockShareholding,週頻)
--
-- FinMind 此 dataset 主要欄位:
--   ForeignInvestmentRemainingShares     外資持有剩餘股數
--   ForeignInvestmentShares              外資已使用股數
--   ForeignInvestmentRemainRatio         (%)外資可投資剩餘比例
--   ForeignInvestmentSharesRatio         (%)外資已持股比例 *
--   ForeignInvestmentUpperLimitRatio     上限比例
--   ChineseInvestmentUpperLimitRatio     陸資上限
--   NumberOfSharesIssued                 已發行股數
--   RecentlyDeclareDate                  最近公告日期
--
-- 重要觀察點是 foreign_holding_ratio 的趨勢(外資增持/減持)
-- 集保戶數真正的「散戶數」其實在 TaiwanStockShareholdingClassification 另一個 dataset
-- 但 free tier 通常 TaiwanStockShareholding 就夠用,本表先 cover 這個

create table if not exists public.stock_shareholding (
  symbol text not null,
  report_date date not null,                       -- FinMind 回的 date(週末公告)
  foreign_remaining_shares numeric(18,0),
  foreign_used_shares numeric(18,0),
  foreign_remain_ratio numeric(8,4),               -- (%)
  foreign_holding_ratio numeric(8,4),              -- (%) 主要追蹤
  foreign_upper_limit_ratio numeric(8,4),
  chinese_upper_limit_ratio numeric(8,4),
  shares_issued numeric(18,0),
  recently_declared_date date,
  fetched_at timestamptz not null default now(),
  primary key (symbol, report_date)
);
create index if not exists idx_share_recent on public.stock_shareholding (report_date desc);
create index if not exists idx_share_symbol_recent on public.stock_shareholding (symbol, report_date desc);

alter table public.stock_shareholding enable row level security;
