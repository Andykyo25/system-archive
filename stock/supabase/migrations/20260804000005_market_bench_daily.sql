-- 檢定用市場基準 market_bench_daily — M10 Phase 2(2026-08-04)
--
-- Phase 2 要一個涵蓋 5 年(含 2022 空頭)的大盤基準,但既有 price_daily 的 0050
-- 只回溯到 2023-01 且帶 adj_factor。兩條路都不能走:
--   ① 把 pre-2023 補進 price_daily → 無從推導當時的 adj_factor,任何算
--      close*adj_factor 的地方都會在 2023-01-03 交界看到假跳空([[L45]] 等級污染)
--   ② 改存 0050 未還原 close → 實測 2025 年顯示 -66.2%、最低 46.6,是**分割**
--      造成的斷崖,不是真實跌幅。未還原價一致的是單位,不是連續性([[L58]])
--
-- 故本表存 **TAIEX 報酬指數**(FinMind TaiwanStockTotalReturnIndex, data_id=TAIEX):
-- 含息、無分割、不依賴 adj_factor,天然適合跨期報酬比較。
-- Sanity(落地後實測):1257 天,單日 |變化| >8% 僅 3 天,極值 -9.70%/+9.25%,
-- 全在台股 10% 漲跌幅限制內 → 無資料斷崖。
--
-- ⚠ 僅供訊號檢定使用,**不要接進 equity-curve / backtest 路徑**(那些用 price_daily)。
-- service_role 全寫,無 client 寫(對齊既有表)。

create table if not exists public.market_bench_daily (
  symbol     text not null,
  trade_date date not null,
  close      numeric(16,4) not null,
  fetched_at timestamptz not null default now(),
  primary key (symbol, trade_date)
);

alter table public.market_bench_daily enable row level security;

comment on table public.market_bench_daily is
  'Benchmark closes for M10 Phase 2 signal testing ONLY (TAIEX total-return index, dividend-inclusive, split-free, from 2021-06). Deliberately separate from price_daily: 0050 there starts 2023-01-03 and carries adj_factor; appending pre-2023 rows without a derivable adj_factor would create a phantom gap for anything computing close*adj_factor, and 0050 raw closes carry a 2025 split cliff (-66% phantom drop). Do NOT wire this into equity-curve / backtest paths.';
