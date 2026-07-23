-- 題材熱度 + 個股動能:「今日盤中即時」主軸(2026-07-22 起,07-23 定案)
--
-- 迭代:① Andy「20日太長,今天大漲的題材才是進場關鍵」→ 主軸改今日,20/60 退參考
--      ② Andy「7/23 盤中榜卻顯示 7/22 收盤」→ 今日改盤中即時
--      ③ 6274 台燿虛高 +22%(缺口股)→ 昨收改「全市場統一前一交易日」
--
-- 「今日」口徑(最終):現價 vs 全市場前一交易日收盤。
--   現價 = v_latest_price_realtime(盤中=intraday 即時、盤後=當日收盤)
--   昨收基準日 = 全市場現價日的前一交易日 = price_daily max(trade_date < 今天)
--     ⚠ 用「全市場統一基準日」而非「各股自己前一筆」——後者對有缺口的股票會虛高:
--       6274 台燿(上櫃,tpex 收料間歇失敗)price_daily 停在 7-20,若取自己前一筆 →
--       盤中現價 7-23 算成 1375/1125=+22%(跨 3 天當單日)。改統一基準日後,6274 缺
--       7-22 收盤 → 無昨收 → today null → 不進榜。誠實勝於虛高。
--     ⚠ 現價日用 as_of_ts::date 不用 current_date(current_date 在 DB 時區會跳隔日撲空)。
--   兩 view 共用此口徑(L42 不做兩套 drift)。
--   前端個股榜另過濾 price_source=twse_yesterday(只有舊價的股票不進今日榜)。

-- ── 共用 CTE 邏輯(兩 view 各自內嵌)──────────────────────────────
--   px_today  = 全市場現價日(max as_of)
--   prev_d    = px_today 的前一交易日
--   prev_close= 各股在 prev_d 的收盤(缺口股無 → today null)

create or replace view public.v_industry_heat as
with px_today as (
  select max((as_of_ts at time zone 'Asia/Taipei')::date) as today_d
  from public.v_latest_price_realtime
),
prev_d as (
  select max(pd.trade_date) as d
  from public.price_daily pd, px_today
  where pd.trade_date < px_today.today_d
),
prev_close as (
  select pd.symbol, pd.close
  from public.price_daily pd, prev_d
  where pd.trade_date = prev_d.d and pd.close > 0
),
rt as (
  select symbol, current_price from public.v_latest_price_realtime
),
joined as (
  select
    i.industry, r.symbol, r.ret_5d_pct, r.ret_20d_pct, r.ret_60d_pct, r.rsi14, r.off_high_60d_pct,
    case
      when pc.close is not null and pc.close > 0 and rt.current_price is not null
        then (rt.current_price / pc.close - 1) * 100
      else null
    end as today_pct
  from public.industry_stocks i
  join public.v_stock_rank r on r.symbol = i.symbol
  left join rt on rt.symbol = i.symbol
  left join prev_close pc on pc.symbol = i.symbol
),
agg as (
  select
    industry,
    count(*) as n_stocks,
    round(avg(ret_5d_pct)::numeric, 2) as avg_ret_5d,
    round(avg(ret_20d_pct)::numeric, 2) as avg_ret_20d,
    round(avg(ret_60d_pct)::numeric, 2) as avg_ret_60d,
    round(percentile_cont(0.5) within group (order by ret_20d_pct)::numeric, 2) as med_ret_20d,
    round(avg(rsi14)::numeric, 1) as avg_rsi,
    round(avg(off_high_60d_pct)::numeric, 1) as avg_off_high,
    count(*) filter (where ret_20d_pct > 0) as n_up_20d,
    round(avg(today_pct)::numeric, 2) as avg_today_pct,
    round(percentile_cont(0.5) within group (order by today_pct)::numeric, 2) as med_today_pct,
    count(*) filter (where today_pct > 0) as n_up_today,
    count(*) filter (where today_pct is not null) as n_today_quoted,
    count(*) filter (where today_pct >= 9.5) as n_limit_up
  from joined where ret_20d_pct is not null group by industry
),
leader as (
  select distinct on (industry) industry, symbol as top_symbol, ret_20d_pct as top_ret_20d
  from joined where ret_20d_pct is not null order by industry, ret_20d_pct desc
),
leader_today as (
  select distinct on (industry) industry, symbol as today_top_symbol, today_pct as today_top_pct
  from joined where today_pct is not null order by industry, today_pct desc
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
  '題材熱度:今日(盤中即時或收盤)/5日/20日/60日。今日 = 現價 vs 全市場前一交易日收盤(缺口股不算)。純價格,非買賣訊號。';

grant select on public.v_industry_heat to service_role;


drop view if exists public.v_symbol_momentum;
create view public.v_symbol_momentum as
with px_today as (
  select max((as_of_ts at time zone 'Asia/Taipei')::date) as today_d
  from public.v_latest_price_realtime
),
prev_d as (
  select max(pd.trade_date) as d
  from public.price_daily pd, px_today
  where pd.trade_date < px_today.today_d
),
prev_close as (
  select pd.symbol, pd.close
  from public.price_daily pd, prev_d
  where pd.trade_date = prev_d.d and pd.close > 0
),
rt as (
  select symbol, current_price, as_of_ts, source as price_source
  from public.v_latest_price_realtime
),
ind as (
  select symbol, string_agg(distinct industry, ' / ' order by industry) as industry
  from public.industry_stocks group by symbol
)
select
  r.symbol,
  nm.name,
  ind.industry,
  case
    when pc.close is not null and pc.close > 0 and rt.current_price is not null
      then round(((rt.current_price / pc.close - 1) * 100)::numeric, 2)
    else null
  end as latest_day_pct,
  rt.as_of_ts as today_as_of,
  rt.price_source,
  rt.current_price,
  r.ret_5d_pct, r.ret_20d_pct, r.ret_60d_pct, r.rsi14, r.off_high_60d_pct,
  r.expected_rank
from public.v_stock_rank r
left join rt on rt.symbol = r.symbol
left join ind on ind.symbol = r.symbol
left join public.stock_names nm on nm.symbol = r.symbol
left join prev_close pc on pc.symbol = r.symbol;

comment on view public.v_symbol_momentum is
  '個股短線動能:今日(盤中即時或收盤)日變化 + 5/20/60 日 + RSI + 距高點 + 排名。今日 = 現價 vs 全市場前一交易日收盤(缺口股不算)。純價格,非買賣訊號。';

grant select on public.v_symbol_momentum to service_role;
