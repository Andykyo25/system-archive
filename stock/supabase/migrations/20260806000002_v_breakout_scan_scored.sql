-- 起漲點掃描 v2:三面向燈號評分(2026-08-06)
--
-- Andy:「介面參考 winvest 四燈號健診」+「三個頁面太多,融合」+「全面以抓住起漲股為主」。
-- winvest 的設計精髓 = 結論先行(總分+燈號)、每個指標明示門檻、一句話看懂。
--
-- 為什麼是三面向不是四面向:winvest 的四燈號含籌碼面,但本系統的籌碼資料
-- (stock_institutional / stock_margin)只覆蓋 v_fetch_universe_stocks 約 118-169 檔,
-- 掃描池 1338 檔中**僅 81 檔(6%)有籌碼**。硬做成主面向 = 94% 的候選顯示空燈號,
-- 或更糟:拿缺料當「中性」計分([[L45]] 不可用假值填充)。故籌碼降級為附加標籤
-- (有資料才顯示),三個主面向全部從 price_daily 算 → 全市場口徑一致。
--
-- 面向設計(起漲導向,總分 100):
--   起漲 34:今日漲幅 / 突破前高 / 量能      ← 「第一根攻擊」本身
--   位置 33:月線斜率 / 乖離 / 站上月線      ← 防追高(已飆過的扣分)
--   動能 33:RSI / MA5>MA20 / 5 日報酬       ← 趨勢品質
--
-- RSI 用簡單移動平均版(SMA-RSI)而非 Wilder 平滑:全市場歷史目前最多 63 根,
-- Wilder 遞迴需要更長 warm-up 才穩定。標註於此,避免日後與 v_stock_rank 的
-- rsi14(Wilder)混淆 —— 兩者本來就是不同 universe 的不同指標。

create or replace view public.v_breakout_scan as
with bounds as (
  select max(trade_date) as last_d, max(trade_date) - 120 as from_d
  from public.price_daily
),
px as (
  select
    p.symbol, p.trade_date, p.close, p.high, p.volume,
    avg(p.close) over w20                                          as ma20,
    avg(p.close) over w5                                           as ma5,
    max(p.high)  over w20_excl                                     as high_20d_excl,
    lag(p.close) over (partition by p.symbol order by p.trade_date) as prev_close,
    lag(p.close, 5) over (partition by p.symbol order by p.trade_date) as close_5d_ago,
    count(*) over w20                                              as n_bars
  from public.price_daily p, bounds b
  where p.trade_date >= b.from_d and p.close > 0
  window
    w5       as (partition by p.symbol order by p.trade_date rows between 4 preceding and current row),
    w20      as (partition by p.symbol order by p.trade_date rows between 19 preceding and current row),
    w20_excl as (partition by p.symbol order by p.trade_date rows between 20 preceding and 1 preceding)
),
chg as (
  select px.*,
    greatest(close - prev_close, 0) as gain,
    greatest(prev_close - close, 0) as loss
  from px
),
rsi_calc as (
  select chg.*,
    avg(gain) over w14 as avg_gain,
    avg(loss) over w14 as avg_loss,
    lag(ma20, 5) over (partition by symbol order by trade_date) as ma20_5d_ago
  from chg
  window w14 as (partition by symbol order by trade_date rows between 13 preceding and current row)
),
today as (
  select r.* from rsi_calc r, bounds b where r.trade_date = b.last_d
),
metrics as (
  select
    t.symbol, si.stock_name as name, si.industry_category, t.trade_date,
    t.close, t.volume,
    round(t.volume / 1000.0)                                  as volume_lots,
    round((t.close / nullif(t.prev_close,0) - 1) * 100, 2)    as day_pct,
    round(t.ma20, 2)                                          as ma20,
    round((t.close / nullif(t.ma20,0) - 1) * 100, 2)          as ma20_gap_pct,
    round((t.ma20 / nullif(t.ma20_5d_ago,0) - 1) * 100, 2)    as ma20_slope_pct,
    round(t.high_20d_excl, 2)                                 as high_20d,
    round((t.close / nullif(t.close_5d_ago,0) - 1) * 100, 2)  as ret_5d_pct,
    round(t.ma5, 2)                                           as ma5,
    round(case when coalesce(t.avg_loss,0) = 0 then 100
               else 100 - 100 / (1 + t.avg_gain / t.avg_loss) end, 1) as rsi14,
    t.n_bars
  from today t
  join public.stock_industry si on si.symbol = t.symbol
  where si.industry_category is not null
    and si.industry_category not in (
      '鋼鐵工業','水泥工業','紡織纖維','食品工業','塑膠工業','橡膠工業','造紙工業',
      '玻璃陶瓷','建材營造','汽車工業','電器電纜','貿易百貨','觀光餐旅','觀光事業',
      '航運業','油電燃氣業','農業科技','農業科技業','金融保險','金融業','化學工業',
      '文化創意業','居家生活','居家生活類','運動休閒','運動休閒類',
      'ETF','上櫃ETF','上櫃指數股票型基金(ETF)','ETN','指數投資證券(ETN)',
      '受益證券','存託憑證','Index','大盤','所有證券'
    )
),
scored as (
  select m.*,
    -- 🚀 起漲 34
    (case when day_pct >= 7 then 14 when day_pct >= 4 then 7 else 0 end)          as s_surge_move,
    (case when close > high_20d then 12 else 0 end)                                as s_surge_break,
    (case when volume >= 5000000 then 8 when volume >= 2000000 then 4 else 0 end)  as s_surge_vol,
    -- 📊 位置 33(防追高)
    (case when ma20_slope_pct > 0 then 13 else 0 end)                              as s_pos_slope,
    (case when ma20_gap_pct < 10 then 12 when ma20_gap_pct < 15 then 6 else 0 end) as s_pos_gap,
    (case when close > ma20 then 8 else 0 end)                                     as s_pos_above,
    -- ⚡ 動能 33
    (case when rsi14 between 50 and 70 then 13
          when rsi14 between 30 and 50 or rsi14 between 70 and 80 then 6
          else 0 end)                                                              as s_mom_rsi,
    (case when ma5 > ma20 then 12 else 0 end)                                      as s_mom_ma,
    (case when ret_5d_pct > 0 then 8 else 0 end)                                   as s_mom_ret5
  from metrics m
  where n_bars >= 20
),
chips as (
  -- 附加標籤:只有 v_fetch_universe_stocks 範圍內的股票有(約 6% 覆蓋),無資料就 null
  select i.symbol,
         sum(i.foreign_net) as fgn_net_5d
  from public.stock_institutional i
  where i.trade_date > (select max(trade_date) - 8 from public.stock_institutional)
  group by i.symbol
)
select
  s.symbol, s.name, s.industry_category, s.trade_date,
  s.close, s.day_pct, s.volume_lots,
  s.ma20, s.ma5, s.ma20_gap_pct, s.ma20_slope_pct, s.high_20d,
  s.rsi14, s.ret_5d_pct,
  (s_surge_move + s_surge_break + s_surge_vol)                  as score_surge,
  (s_pos_slope + s_pos_gap + s_pos_above)                       as score_position,
  (s_mom_rsi + s_mom_ma + s_mom_ret5)                           as score_momentum,
  (s_surge_move + s_surge_break + s_surge_vol
   + s_pos_slope + s_pos_gap + s_pos_above
   + s_mom_rsi + s_mom_ma + s_mom_ret5)                         as score_total,
  -- Andy 原始五條件(嚴格版)是否全過 —— 燈號是連續評分,這個是二元把關
  (s.day_pct >= 7 and s.volume >= 5000000 and s.close >= 20
   and s.close > s.high_20d and s.close > s.ma20 and s.ma20_slope_pct > 0
   and s.ma20_gap_pct < 15)                                     as passes_all,
  c.fgn_net_5d
from scored s
left join chips c on c.symbol = s.symbol
where s.close >= 20
order by passes_all desc, score_total desc, s.day_pct desc;

comment on view public.v_breakout_scan is
  'Breakout scan v2 (2026-08-06): three-dimension traffic-light scoring (surge 34 / position 33 / momentum 33 = 100) over the whole market, plus Andy original five-condition binary gate as passes_all. Chip data is an optional tag only - stock_institutional covers ~6% of the scan pool, too sparse for a scored dimension without faking neutral values (L45). RSI is SMA-based, not Wilder, because whole-market history is currently max 63 bars; do not conflate with v_stock_rank.rsi14. Candidate generator, NOT a buy signal: 124-trigger review showed 5d excess -0.81pp, win rate 42.7% (sample too short to conclude either way, see L57/L60).';

grant select on public.v_breakout_scan to service_role;
