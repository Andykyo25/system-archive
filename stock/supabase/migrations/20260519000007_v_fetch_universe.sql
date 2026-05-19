-- 持股自動完整追蹤根治:日更收料 symbol 單一事實來源
--
-- 問題:4 個舊 fetch EF(daily-prices/fundamentals/monthly-revenue/valuation)讀
--   `holdings` 表(closed_at is null),不含 holdings_transactions。籌碼 4 EF
--   (institutional/margin/lending/shareholding)已升級讀 v_holdings_current(M8.5)。
--   drift → 用 transaction-log 記的持股(如 6285)被價格類 EF 漏收 → 分析殘缺
--   (fund/mom 0/0、signal=insufficient_data)。
--
-- 根治:建單一 view,4 個舊 EF 改讀它(含 fallback),根絕未來各 EF 各自定義
--   再 drift。對齊 score_universe_at 選股 universe 精神 —— 凡會被 /rank /holdings
--   分析的 symbol 都該被完整收料。
--
-- 用 v_holdings_current(當前持有)非 holdings_transactions(含已出清):跟籌碼 EF
--   一致 + 省 quota(已出清股不需日更,backfill 過的歷史留著)。
-- union 本身去重。純收料用,不碰 score_universe_at / 選股鏈。

create or replace view public.v_fetch_universe as
select symbol from public.v_holdings_current where symbol is not null
union
select symbol from public.watchlist where symbol is not null
union
select symbol from public.industry_stocks where symbol is not null
union
select symbol from public.stock_universe where symbol is not null
union
select symbol from public.etf_metadata where symbol is not null;

comment on view public.v_fetch_universe is
  '日更收料 symbol 單一來源(v_holdings_current ∪ watchlist ∪ industry_stocks
   ∪ stock_universe ∪ etf_metadata)。fetch-daily-prices/fundamentals/
   monthly-revenue/valuation 改讀此 view 根絕 holdings_transactions 漏收 drift。
   純收料用,不影響 score_universe_at / 選股。';
