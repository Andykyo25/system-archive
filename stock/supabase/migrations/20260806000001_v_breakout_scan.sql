-- 起漲點掃描 v_breakout_scan — M12(2026-08-06)
--
-- Andy:「目前的排行只是把已經漲的股票列出來,我抓不到起漲點」。
-- 既有 v_symbol_momentum 的兩個結構性問題:
--   ① 池子只有 industry_stocks 137 檔題材股 → 今天真正起漲的多半根本不在名單裡
--   ② 排序是「已實現漲幅」→ 本質是後照鏡
-- 本 view 改成**全市場掃描**(price_daily 每日約 1950 檔),並用「第一根攻擊」的
-- 型態條件過濾,而不是排序已漲幅度。
--
-- Andy 定義的五條件(2026-08-06 確認):
--   ① 今日漲幅 >= 7%(漲停 ~ 7% 的前段班)
--   ② 成交量 > 5000 張(= 5,000,000 股;price_daily.volume 單位為股)
--   ③ 股價 >= 20 元(排除雞蛋水餃股)
--   ④ 進攻意圖 = 突破前 20 日最高 + 站上月線且月線轉揚 + 乖離 < 15%
--      (「突破」抓剛跨出盤整區,「月線轉揚」濾掉區間徘徊,「乖離」濾掉已經飆過的)
--   ⑤ 排除傳產 + 金融(用 stock_industry 的官方產業別),同時排除 ETF/ETN 等非個股
--
-- ⚠ 這是**盤後掃描**:條件② 需要當日成交量,而 v_latest_price_realtime 只有現價
--   沒有量,盤中無法判斷。故以 price_daily 收盤資料為準,收盤後選股、隔日進場。
--
-- ⚠ 未經回測驗證。此 view 只做「型態過濾」,不宣稱這些條件能賺錢 ——
--   要不要驗、怎麼驗,見 [[L57]](樣本必須跨 regime + 分年看穩健性)。

create or replace view public.v_breakout_scan as
with bounds as (
  -- 只算最近 120 個日曆日,避免全表掃描;足夠算 MA20 與 20 日高
  select max(trade_date) as last_d, max(trade_date) - 120 as from_d
  from public.price_daily
),
px as (
  select
    p.symbol, p.trade_date, p.close, p.high, p.volume,
    avg(p.close) over w20                                    as ma20,
    max(p.high)  over w20_excl                               as high_20d_excl,
    lag(p.close) over (partition by p.symbol order by p.trade_date) as prev_close
  from public.price_daily p, bounds b
  where p.trade_date >= b.from_d and p.close > 0
  window
    w20      as (partition by p.symbol order by p.trade_date rows between 19 preceding and current row),
    w20_excl as (partition by p.symbol order by p.trade_date rows between 20 preceding and 1 preceding)
),
enriched as (
  select
    px.*,
    lag(ma20, 5) over (partition by symbol order by trade_date) as ma20_5d_ago,
    count(*)     over (partition by symbol order by trade_date
                       rows between 19 preceding and current row) as n_bars
  from px
),
today as (
  select e.*
  from enriched e, bounds b
  where e.trade_date = b.last_d
),
scored as (
  select
    t.symbol,
    si.stock_name                                            as name,
    si.industry_category,
    t.trade_date,
    t.close,
    round(t.volume / 1000.0)                                 as volume_lots,
    round((t.close / nullif(t.prev_close,0) - 1) * 100, 2)   as day_pct,
    round(t.ma20, 2)                                         as ma20,
    round((t.close / nullif(t.ma20,0) - 1) * 100, 2)         as ma20_gap_pct,
    round((t.ma20 / nullif(t.ma20_5d_ago,0) - 1) * 100, 2)   as ma20_slope_pct,
    round(t.high_20d_excl, 2)                                as high_20d,
    -- 逐條旗標(前端可顯示為什麼進榜 / 差在哪一條)
    (t.close / nullif(t.prev_close,0) - 1) * 100 >= 7        as f_surge,
    t.volume >= 5000000                                      as f_volume,
    t.close >= 20                                            as f_price,
    t.close > t.high_20d_excl                                as f_breakout,
    t.close > t.ma20 and t.ma20 > t.ma20_5d_ago              as f_ma20_up,
    (t.close / nullif(t.ma20,0) - 1) < 0.15                  as f_not_extended,
    t.n_bars >= 20                                           as f_enough_history
  from today t
  join public.stock_industry si on si.symbol = t.symbol
  where si.industry_category is not null
    -- ⑤ 排除傳產 + 金融
    and si.industry_category not in (
      '鋼鐵工業','水泥工業','紡織纖維','食品工業','塑膠工業','橡膠工業','造紙工業',
      '玻璃陶瓷','建材營造','汽車工業','電器電纜','貿易百貨','觀光餐旅','觀光事業',
      '航運業','油電燃氣業','農業科技','農業科技業','金融保險','金融業','化學工業',
      '文化創意業','居家生活','居家生活類','運動休閒','運動休閒類'
    )
    -- 排除 ETF / ETN / 受益證券 / 指數等非個股
    and si.industry_category not in (
      'ETF','上櫃ETF','上櫃指數股票型基金(ETF)','ETN','指數投資證券(ETN)',
      '受益證券','存託憑證','Index','大盤','所有證券'
    )
)
select
  symbol, name, industry_category, trade_date,
  close, day_pct, volume_lots,
  ma20, ma20_gap_pct, ma20_slope_pct, high_20d,
  f_surge, f_volume, f_price, f_breakout, f_ma20_up, f_not_extended,
  (f_surge::int + f_volume::int + f_price::int
   + f_breakout::int + f_ma20_up::int + f_not_extended::int)  as conditions_met,
  (f_surge and f_volume and f_price
   and f_breakout and f_ma20_up and f_not_extended)           as passes_all
from scored
where f_enough_history
order by passes_all desc, conditions_met desc, day_pct desc;

comment on view public.v_breakout_scan is
  'Whole-market breakout scan (M12, 2026-08-06) implementing Andy five entry conditions: day gain >=7%, volume >5000 lots, price >=20, breakout above prior 20-day high with rising MA20 and <15% extension, excluding traditional-industry/financial/non-equity. Replaces the 137-stock themed pool with the full ~1950-symbol price_daily universe - the small pool was a main reason breakouts were being missed. END-OF-DAY only: intraday volume is unavailable (v_latest_price_realtime carries no volume). Pattern filter only, NOT backtested - see lessons L57 before treating it as an edge.';

grant select on public.v_breakout_scan to service_role;
