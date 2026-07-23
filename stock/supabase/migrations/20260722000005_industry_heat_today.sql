-- 題材熱度 + 個股動能改「最新交易日」主軸(2026-07-22)
--
-- 起因:Andy「20日好像太長,像今天大漲的題材才是進場關鍵」。短線持有期用 20 日平均
--   描述題材熱度是錯配 —— 20 日榜給的是「上個月的贏家」,今日榜才是「今天在發動的」。
--
-- 口徑:各股 price_daily 最新兩筆收盤的日變化。
--   為何不用 v_latest_price_realtime vs current_date 昨收:
--     ① current_date 在 DB 時區會跳到隔日 → trade_date=current_date 對不到,全撲空
--     ② 新加的題材股不在即時料收集範圍 → realtime 只給昨收 → 今日% 全 0
--   「各股最新兩筆」不依賴 current_date 對齊、不依賴即時料,對新題材股一樣算得出
--   (它們 price_daily 有最新收盤)。語意 = 最新交易日日漲跌;盤後=今天,非盤中即時。
--   v_industry_heat 與 v_symbol_momentum 共用此口徑(L42 不做兩套 drift)。

-- ── 1. 題材熱度(改今日主軸)────────────────────────────────────────
create or replace view public.v_industry_heat as
with day_chg as (
  select
    symbol,
    (array_agg(close order by trade_date desc))[1] as last_c,
    (array_agg(close order by trade_date desc))[2] as prev_c
  from public.price_daily
  where close > 0 and trade_date >= current_date - interval '15 days'
  group by symbol
),
joined as (
  select
    i.industry,
    r.symbol,
    r.ret_5d_pct,
    r.ret_20d_pct,
    r.ret_60d_pct,
    r.rsi14,
    r.off_high_60d_pct,
    case
      when d.prev_c is not null and d.prev_c > 0 and d.last_c is not null
        then (d.last_c / d.prev_c - 1) * 100
      else null
    end as today_pct
  from public.industry_stocks i
  join public.v_stock_rank r on r.symbol = i.symbol
  left join day_chg d on d.symbol = i.symbol
),
agg as (
  select
    industry,
    count(*)                                                          as n_stocks,
    round(avg(ret_5d_pct)::numeric, 2)                                as avg_ret_5d,
    round(avg(ret_20d_pct)::numeric, 2)                               as avg_ret_20d,
    round(avg(ret_60d_pct)::numeric, 2)                               as avg_ret_60d,
    round(percentile_cont(0.5) within group (order by ret_20d_pct)::numeric, 2) as med_ret_20d,
    round(avg(rsi14)::numeric, 1)                                     as avg_rsi,
    round(avg(off_high_60d_pct)::numeric, 1)                          as avg_off_high,
    count(*) filter (where ret_20d_pct > 0)                           as n_up_20d,
    round(avg(today_pct)::numeric, 2)                                 as avg_today_pct,
    round(percentile_cont(0.5) within group (order by today_pct)::numeric, 2) as med_today_pct,
    count(*) filter (where today_pct > 0)                             as n_up_today,
    count(*) filter (where today_pct is not null)                     as n_today_quoted,
    count(*) filter (where today_pct >= 9.5)                          as n_limit_up
  from joined
  where ret_20d_pct is not null
  group by industry
),
leader as (
  select distinct on (industry) industry, symbol as top_symbol, ret_20d_pct as top_ret_20d
  from joined
  where ret_20d_pct is not null
  order by industry, ret_20d_pct desc
),
leader_today as (
  select distinct on (industry) industry, symbol as today_top_symbol, today_pct as today_top_pct
  from joined
  where today_pct is not null
  order by industry, today_pct desc
)
select
  a.industry, a.n_stocks, a.avg_ret_5d, a.avg_ret_20d, a.med_ret_20d, a.avg_ret_60d,
  a.avg_rsi, a.avg_off_high, a.n_up_20d, l.top_symbol, l.top_ret_20d,
  a.avg_today_pct, a.med_today_pct, a.n_up_today, a.n_today_quoted, a.n_limit_up,
  lt.today_top_symbol, lt.today_top_pct
from agg a
left join leader l on l.industry = a.industry
left join leader_today lt on lt.industry = a.industry;

comment on view public.v_industry_heat is
  '題材熱度:各產業成分股的最新交易日/5日/20日/60日報酬(平均+中位)、上漲家數、漲停家數、最強股。最新交易日 = price_daily 各股最新兩筆收盤日變化(不依賴 current_date/即時料)。純價格,非買賣訊號 —— 單日雜訊高,需與 5 日並看才知是題材成形還是一日行情。';

grant select on public.v_industry_heat to service_role;


-- ── 2. 個股短線動能 view ───────────────────────────────────────────
create or replace view public.v_symbol_momentum as
with day_chg as (
  select
    symbol,
    (array_agg(close order by trade_date desc))[1]      as last_c,
    (array_agg(close order by trade_date desc))[2]      as prev_c,
    (array_agg(trade_date order by trade_date desc))[1] as last_date
  from public.price_daily
  where close > 0 and trade_date >= current_date - interval '15 days'
  group by symbol
),
ind as (
  select symbol, string_agg(distinct industry, ' / ' order by industry) as industry
  from public.industry_stocks
  group by symbol
)
select
  r.symbol,
  nm.name,
  ind.industry,
  case
    when d.prev_c is not null and d.prev_c > 0 and d.last_c is not null
      then round(((d.last_c / d.prev_c - 1) * 100)::numeric, 2)
    else null
  end                                    as latest_day_pct,
  d.last_date,
  r.ret_5d_pct, r.ret_20d_pct, r.ret_60d_pct, r.rsi14, r.off_high_60d_pct,
  r.expected_rank, r.latest_close
from public.v_stock_rank r
left join public.stock_names nm on nm.symbol = r.symbol
left join ind on ind.symbol = r.symbol
left join day_chg d on d.symbol = r.symbol;

comment on view public.v_symbol_momentum is
  '個股短線動能:最新交易日日變化 + 5/20/60 日報酬 + RSI + 距高點 + 綜合排名。最新交易日口徑與 v_industry_heat 一致。純價格,非買賣訊號。';

grant select on public.v_symbol_momentum to service_role;
