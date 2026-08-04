-- 大盤籌碼日表 — M10 Phase 1 schema(2026-08-04)
--
-- Andy 提的五條擇時指標裡,①外資期貨留倉 / ③全市場融資餘額 是系統缺料的兩條
-- (②台積電外資買賣走既有 stock_institutional、④^SOX ⑤韓股走既有 overseas_indicators)。
-- 本表只放「市場層級」日頻籌碼,個股層級一律不進來(那是 stock_institutional/stock_margin 的地盤)。
--
-- 為什麼是一張寬表而不是三張(或長格式):三個 FinMind dataset 都是市場層級、同一個交易日
-- 一列,由同一個 EF(fetch-market-chips)一次抓齊一次寫入 → 沒有 partial upsert 把彼此欄位
-- 洗成 null 的風險,前端/view 也不必三方 join。
--
-- 資料源(2026-08-04 實打驗證,免 token、單 call 可抓滿 486 交易日,不吃 finmind quota):
--   TaiwanFuturesInstitutionalInvestors (data_id=TX)     → fut_*
--   TaiwanStockTotalMarginPurchaseShortSale              → margin_* / short_*
--   TaiwanStockTotalInstitutionalInvestors               → *_net_buy
--
-- service_role 全寫,無 client 寫(對齊既有表,rls_enabled_no_policy 為預期內)。

create table if not exists public.market_chips_daily (
  trade_date date primary key,

  -- 台指期(大台 TX)三大法人「未平倉」口數 = 留倉部位,非當日成交。
  -- net = long - short;外資 net 為負 = 淨空單,net 由負轉正/空單減少 = Andy 說的「回補」。
  fut_foreign_oi_long   integer,
  fut_foreign_oi_short  integer,
  fut_foreign_oi_net    integer,
  fut_trust_oi_net      integer,
  fut_dealer_oi_net     integer,

  -- 全市場融資融券餘額(FinMind TodayBalance)。shares 單位為張,amount 為元。
  margin_balance_shares bigint,
  margin_balance_amount bigint,
  short_balance_shares  bigint,

  -- 全市場三大法人買賣超金額(元,buy - sell)。與 fut_* 是現貨/期貨兩面,
  -- Phase 2 要測的共線疑慮主要就在這兩者之間。
  foreign_net_buy       bigint,
  trust_net_buy         bigint,

  fetched_at timestamptz not null default now()
);

alter table public.market_chips_daily enable row level security;

comment on table public.market_chips_daily is
  'Market-wide daily chip indicators (foreign TX futures open interest, total margin balance, total institutional net buy) from FinMind. One row per TW trading day, written by EF fetch-market-chips. M10 Phase 1, 2026-08-04. NOT validated as a timing signal yet - Phase 2 PIT test decides whether v_market_temp graduates from dashboard to gate.';
comment on column public.market_chips_daily.fut_foreign_oi_net is
  'Foreign net open interest in TX futures (long - short, in contracts). Negative = net short.';
comment on column public.market_chips_daily.margin_balance_shares is
  'Total market margin purchase balance in lots (張). Falling balance = retail deleveraging.';
