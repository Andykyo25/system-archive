-- v_entry_quality — 價位質量層(2026-06-10,「好股等好價」工程 A)
--
-- 動機:v_stock_rank 是橫斷面選股(what),動能因子天生把已漲一段的股票排前面
--   → rank 靠前 ≈ 追高區。本 view 獨立回答「現在買的價位好不好」(when/at),
--   分層不動排名結構(L36:勿把排名改造成 timing 工具)。
-- 規則:純 SQL 標準技術參數(MA20/RSI/布林 20,2/fib 38.2/量比),零調參,
--   走 B 資訊呈現 — 規則化「不追高、等回檔」紀律,非 alpha 宣稱。
-- entry_zone 四態(判定順序 broken → chase → pullback → neutral):
--   broken   趨勢破壞:跌破 MA60 且距 60d 高 >25%(別接刀)
--   chase    追高區:偏離 MA20 >+10% 或 RSI>75 或布林 %B>85
--   pullback 回檔至支撐:偏離 MA20 ±5% 內 且 距 60d 高 ≥8% 且 RSI<65
--   neutral  其餘
-- 耐心價:patience_ma20(主錨)+ patience_fib38(60d 高低 38.2% 回撤位,輔助)
-- 效能:base 讀 mv_factor_scores(物化);價量補算限 universe + 120 天下界(sargable)

create or replace view public.v_entry_quality as
with uni as (
  select symbol, latest_close, ma20_now, ma60_now, rsi14, off_high_60d_pct
  from mv_factor_scores
),
px as (
  select symbol, close * coalesce(adj_factor, 1) as adj_c, volume,
         row_number() over (partition by symbol order by trade_date desc) as rn
  from price_daily
  where symbol in (select symbol from uni) and close > 0
    and trade_date > current_date - interval '120 days'
),
boll as (
  select symbol,
    avg(adj_c) as mid,
    avg(adj_c) + 2 * stddev_samp(adj_c) as up,
    avg(adj_c) - 2 * stddev_samp(adj_c) as lo
  from px where rn <= 20
  group by symbol having count(*) >= 20
),
vol_cmp as (
  select symbol,
    avg(volume) filter (where rn <= 5) as avg_v5,
    avg(volume) filter (where rn <= 20) as avg_v20
  from px where rn <= 20
  group by symbol
),
hl60 as (
  select symbol, max(adj_c) as hi60, min(adj_c) as lo60
  from px where rn <= 60
  group by symbol
)
select
  u.symbol,
  u.latest_close,
  round(((u.latest_close - u.ma20_now) / nullif(u.ma20_now, 0) * 100)::numeric, 1) as dev_ma20_pct,
  round(u.off_high_60d_pct::numeric, 1) as off_high_pct,
  round(u.rsi14::numeric, 1) as rsi14,
  case when b.up > b.lo
    then round(((u.latest_close - b.lo) / (b.up - b.lo) * 100)::numeric, 0)
  end as boll_pctb,
  round((vc.avg_v5 / nullif(vc.avg_v20, 0))::numeric, 2) as vol_ratio_5_20,
  round(u.ma20_now::numeric, 2) as patience_ma20,
  round((h.hi60 - 0.382 * (h.hi60 - h.lo60))::numeric, 2) as patience_fib38,
  case
    when u.ma20_now is null or u.ma60_now is null or u.latest_close is null
      or u.off_high_60d_pct is null then 'unknown'
    when u.latest_close < u.ma60_now and u.off_high_60d_pct > 25 then 'broken'
    when (u.latest_close - u.ma20_now) / nullif(u.ma20_now, 0) > 0.10
      or u.rsi14 > 75
      or (b.up > b.lo and (u.latest_close - b.lo) / (b.up - b.lo) > 0.85) then 'chase'
    when abs((u.latest_close - u.ma20_now) / nullif(u.ma20_now, 0)) <= 0.05
      and u.off_high_60d_pct >= 8
      and (u.rsi14 is null or u.rsi14 < 65) then 'pullback'
    else 'neutral'
  end as entry_zone
from uni u
left join boll b on b.symbol = u.symbol
left join vol_cmp vc on vc.symbol = u.symbol
left join hl60 h on h.symbol = u.symbol;

comment on view public.v_entry_quality is
  '價位質量層(2026-06-10):entry_zone 四態(broken/chase/pullback/neutral)+ 耐心價
   (MA20/fib38.2)。純 SQL 標準參數零調參,走 B 資訊呈現。base = mv_factor_scores,
   手動 backfill 後 mv 要先 refresh 本 view 才會跟上。';
