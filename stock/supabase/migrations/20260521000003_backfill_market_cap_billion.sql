-- 2026-05-21: 從本地資料一次性 backfill market_cap_billion(億元)
--
-- 背景:
--   stock_universe / industry_stocks 的 market_cap_billion 全為 null,
--   原本要等 reselect-industry-stocks-monthly EF 月底重抓才會有,
--   但那支 EF 目前也沒收 market_cap(獨立的修工程,記在 todo)。
--
-- 做法(零 API quota):
--   1. 從 stock_shareholding 取每檔最新 shares_issued(已發行股數,股)
--   2. 從 price_daily 取每檔最新 close(收盤價,元)
--   3. market_cap_billion = shares_issued × close / 1e8 (轉成億元)
--   4. 同步 update 到 stock_universe + industry_stocks
--
-- 驗證(2026-05-21 執行結果):
--   2330 台積電 = 566,626 億元
--   2454 聯發科 =  51,806 億元
--   2308 台達電 =  49,743 億元
--   2317 鴻海   =  33,514 億元
--   3711 日月光  =  21,050 億元
--   共填上 144 檔(industry_stocks 主集合)
--
-- 解鎖:
--   v_holdings_signals v3 可以加「市值分檔 vs 大盤連動度」訊號
--   (Andy 三項建議的第 2 項 — 中小型 OTC vs 權值 vs 0050)

with mc as (
  select
    sh.symbol,
    (sh.shares_issued::numeric * pd.close / 100000000)::numeric(14, 2) as cap_b
  from (
    select distinct on (symbol)
      symbol, shares_issued
    from stock_shareholding
    where shares_issued > 0
    order by symbol, report_date desc
  ) sh
  join (
    select distinct on (symbol)
      symbol, close
    from price_daily
    where close > 0
    order by symbol, trade_date desc
  ) pd on pd.symbol = sh.symbol
)
update stock_universe su
set market_cap_billion = mc.cap_b
from mc
where su.symbol = mc.symbol;

with mc as (
  select
    sh.symbol,
    (sh.shares_issued::numeric * pd.close / 100000000)::numeric(14, 2) as cap_b
  from (
    select distinct on (symbol)
      symbol, shares_issued
    from stock_shareholding
    where shares_issued > 0
    order by symbol, report_date desc
  ) sh
  join (
    select distinct on (symbol)
      symbol, close
    from price_daily
    where close > 0
    order by symbol, trade_date desc
  ) pd on pd.symbol = sh.symbol
)
update industry_stocks ist
set market_cap_billion = mc.cap_b
from mc
where ist.symbol = mc.symbol;
