-- Price correctness only; no weight tuning. Restore previous view definition to roll back.
create or replace view public.v_breakout_scan as
with bounds as (
  select max(trade_date) as last_d, max(trade_date) - 120 as from_d
  from public.price_daily
),
normalized as (
  select p.*, p.close * p.adj_factor as adj_close,
         p.high * p.adj_factor as adj_high
  from public.price_daily p, bounds b
  where p.trade_date >= b.from_d and p.close > 0 and p.adj_factor > 0
),
px as (
  select
    p.symbol, p.trade_date, p.adj_close as close, p.adj_high as high, p.volume,
    p.close as raw_close, p.adj_factor,
    avg(p.adj_close) over w20                                          as ma20,
    avg(p.adj_close) over w5                                           as ma5,
    max(p.adj_high)  over w20_excl                                     as high_20d_excl,
    lag(p.adj_close) over (partition by p.symbol order by p.trade_date) as prev_close,
    lag(p.adj_close, 5) over (partition by p.symbol order by p.trade_date) as close_5d_ago,
    count(p.adj_high) over w20_excl as n_bars,
    count(*) over (partition by p.symbol order by p.trade_date rows between 24 preceding and current row) as n_slope
  from normalized p
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
    t.raw_close as close, t.volume,
    round(t.volume / 1000.0)                                  as volume_lots,
    round((t.close / nullif(t.prev_close,0) - 1) * 100, 2)    as day_pct,
    round(t.ma20 / t.adj_factor, 2)                                          as ma20,
    round((t.close / nullif(t.ma20,0) - 1) * 100, 2)          as ma20_gap_pct,
    round((t.ma20 / nullif(t.ma20_5d_ago,0) - 1) * 100, 2)    as ma20_slope_pct,
    round(t.high_20d_excl / t.adj_factor, 2)                                 as high_20d,
    round((t.close / nullif(t.close_5d_ago,0) - 1) * 100, 2)  as ret_5d_pct,
    round(t.ma5 / t.adj_factor, 2)                                           as ma5,
    round(case when t.avg_gain = 0 and t.avg_loss = 0 then 50
               when coalesce(t.avg_loss,0) = 0 then 100
               else 100 - 100 / (1 + t.avg_gain / t.avg_loss) end, 1) as rsi14,
    t.n_bars, t.n_slope
  from today t
  join public.stock_industry si on si.symbol = t.symbol
  where si.industry_category is not null
    and not exists (
      select 1 from public.industry_policy ip
      where ip.industry = si.industry_category and ip.excluded
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
  where n_bars >= 20 and n_slope >= 25
),
market_days as (
  select distinct trade_date from public.price_daily, bounds b
  where trade_date <= b.last_d and trade_date >= b.last_d - 30
  order by trade_date desc limit 5
),
chips as (
  -- Require all five market sessions for EACH symbol, not a table-wide max date.
  select i.symbol, sum(i.foreign_net) as fgn_net_5d
  from public.stock_institutional i
  join market_days d on d.trade_date = i.trade_date
  group by i.symbol
  having count(distinct i.trade_date) = 5 and count(i.foreign_net) = 5
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
  'breakout-v3-adjusted: unchanged scoring weights; adjusted technical prices converted back to signal-day price units; 20 prior bars; per-symbol five-session chips.';

-- Preserve historical provenance. Do not relabel old frozen picks as the new strategy.
alter table public.scan_picks add column if not exists strategy_version text;
alter table public.scan_picks alter column strategy_version set default 'breakout-v3-adjusted';
