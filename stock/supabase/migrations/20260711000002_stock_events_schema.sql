-- 事件日曆(規畫④B 2026-07-11):法說會/除權息/股東會
-- 全市場皆存(表小 ~2k rows;盲區單警示也需要)。零外部 quota(TWSE/TPEX OpenAPI)。
create table public.stock_events (
  symbol text not null,
  event_type text not null, -- ex_dividend | shareholder_meeting | investor_conference
  event_date date not null,
  detail jsonb,             -- {kind, cash_dividend, market, subject, book_closure_start...}
  source text not null,     -- twse_twt48u | tpex_prepost | twse_t187ap38 | twse_t187ap04
  fetched_at timestamptz not null default now(),
  primary key (symbol, event_type, event_date)
);
create index idx_stock_events_date on public.stock_events (event_date);
alter table public.stock_events enable row level security;
