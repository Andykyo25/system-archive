-- B1(2026-06-30):Shadow Account 交易行為分析 — 借鏡 HKUDS/Vibe-Trading 的
--   「分析使用者自己的交易行為」概念,用本專案既有的 holdings_transactions /
--   v_holdings_realized 即可算,無需新資料源。取代被刪的靜態「給 Andy 的建議」widget
--   (那塊內容寫死永不更新);這個 view 隨每筆新平倉自動更新。
--
-- 每筆「波段平倉」(SELL,不含當沖)算:
--   * holding_days:首次 BUY(<= 賣出日)到賣出日的日曆天(平均成本制下無嚴格 lot,
--     用「首買到此賣」近似,與 dashboard firstBuyMap 口徑一致)
--   * is_win:realized_pnl > 0
--   * fwd_20d_pct:賣出後第 20 個交易日收盤 vs 賣出價(= 若續抱 20 交易日的結果)
--   * fwd_max20_pct:賣出後 20 交易日內最高收盤 vs 賣出價(= 完美時機可多賺多少;桌上留多少)
--   * fwd_days_available:賣後在 price_daily 可觀察的交易日數(上限 20)
--
-- 用途:量化「賣太早 / 出場時機」。fwd_20d_pct 正 = 續抱更賺(賣太早);負 = 早出躲跌(時機佳)。
--
-- 誠實 caveat:
--   1. 已出清且不在追蹤池(stock_universe/watchlist/industry/etf)的股,賣後 price_daily
--      不再收料 → fwd_days_available=0、fwd_* 為 null([[L45]] 不偽造,顯示 N/A)
--   2. fwd 用 raw close vs raw 賣出價;20 日窗內若遇除權息會略失真(成長股短窗影響小)
--   3. 樣本小(個人帳戶),勝率/均值僅供自我檢視,非統計顯著([[L38]] 精神)
--
-- 安全:純讀 view(v_holdings_realized + holdings_transactions + price_daily),service_role
--   server-side 查詢,無 RLS policy 需求(與既有 v_holdings_* 一致)。append-only 不動既有物件。

create or replace view public.v_trade_behavior as
with base as (
  select
    v.txn_id,
    v.symbol,
    v.sell_date,
    v.qty_sold,
    v.sell_price,
    v.realized_pnl,
    v.realized_pct,
    (v.realized_pnl > 0) as is_win,
    (v.sell_date - (
      select min(b.txn_date)
      from public.holdings_transactions b
      where b.symbol = v.symbol
        and b.txn_type = 'BUY'
        and b.txn_date <= v.sell_date
    )) as holding_days,
    least((
      select count(*)
      from public.price_daily p
      where p.symbol = v.symbol and p.trade_date > v.sell_date
    ), 20) as fwd_days_available,
    (
      select p.close
      from public.price_daily p
      where p.symbol = v.symbol and p.trade_date > v.sell_date
      order by p.trade_date
      offset 19 limit 1
    ) as fwd_20d_close,
    (
      select max(w.close)
      from (
        select pp.close
        from public.price_daily pp
        where pp.symbol = v.symbol and pp.trade_date > v.sell_date
        order by pp.trade_date
        limit 20
      ) w
    ) as fwd_max20_close
  from public.v_holdings_realized v
)
select
  base.txn_id,
  base.symbol,
  base.sell_date,
  base.qty_sold,
  base.realized_pnl,
  base.realized_pct,
  base.is_win,
  base.holding_days,
  base.fwd_days_available,
  case when base.fwd_20d_close is not null and base.sell_price > 0
       then round((base.fwd_20d_close / base.sell_price - 1) * 100, 2)
  end as fwd_20d_pct,
  case when base.fwd_max20_close is not null and base.sell_price > 0
       then round((base.fwd_max20_close / base.sell_price - 1) * 100, 2)
  end as fwd_max20_pct
from base;

comment on view public.v_trade_behavior is
  'B1 交易行為分析:每筆波段平倉 + 持有天數 + 賣後 20 交易日走勢/最高(量化賣太早)。';
