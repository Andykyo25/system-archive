-- 籌碼 4 EF 收料 universe 統一(L42 做法3 / todo「後續可選①」)
--
-- 背景:c4e850f 已把價格 4 EF 改讀 v_fetch_universe(=5 source 含 etf_metadata)。
--   籌碼 4 EF(institutional/margin/lending/shareholding)仍 inline
--   v_holdings_current ∪ watchlist ∪ industry_stocks ∪ stock_universe(4 source,
--   無 etf_metadata)→ 兩套 pattern,未來新增 source 表會再 drift(L42 動機未根治)。
--
-- 不是機械鏡像:v_fetch_universe 含 11 檔 ETF(0050/0056/00878…),籌碼側現用
--   universe 刻意排除 ETF(institutional「ETF 沒法人買賣超」、且 lending 配額已
--   慢性耗盡,多打 ETF 更糟)。直接讓籌碼 EF 改讀 v_fetch_universe = 行為改變。
--
-- Option A(雙 view,零行為改變,真正單一來源):
--   1. v_fetch_universe_stocks = 現籌碼 4 source(stock 底集,不含 ETF)
--      → 籌碼 4 EF 改讀此 view;未來加 source 表 1 處改、籌碼+價格 8 EF 自動同步。
--   2. v_fetch_universe 改 = v_fetch_universe_stocks ∪ etf_metadata
--      → 與原 5-source union 集合完全等同(UNION 去重),價格 4 EF 零變、零退化。
-- 純收料用,不碰 score_universe_at / 選股鏈。

create or replace view public.v_fetch_universe_stocks as
select symbol from public.v_holdings_current where symbol is not null
union
select symbol from public.watchlist where symbol is not null
union
select symbol from public.industry_stocks where symbol is not null
union
select symbol from public.stock_universe where symbol is not null;

comment on view public.v_fetch_universe_stocks is
  '籌碼/個股收料 symbol 單一來源 stock 底集(v_holdings_current ∪ watchlist
   ∪ industry_stocks ∪ stock_universe,不含 ETF)。fetch-finmind-
   institutional/margin/lending/shareholding 改讀此 view 根絕兩套 pattern drift。
   純收料用,不影響 score_universe_at / 選股。';

-- v_fetch_universe 改建在 stock 底集之上 + ETF additive layer。
-- 集合與原 5-source union 完全等同 → 價格 4 EF(讀 v_fetch_universe)零變。
create or replace view public.v_fetch_universe as
select symbol from public.v_fetch_universe_stocks
union
select symbol from public.etf_metadata where symbol is not null;

comment on view public.v_fetch_universe is
  '日更收料 symbol 單一來源(v_fetch_universe_stocks ∪ etf_metadata)。
   = stock 底集 + ETF。fetch-daily-prices/fundamentals/monthly-revenue/
   valuation 讀此 view(需 ETF 價格如 0050 benchmark);籌碼 4 EF 讀
   v_fetch_universe_stocks(排除 ETF)。純收料用,不影響選股。';
