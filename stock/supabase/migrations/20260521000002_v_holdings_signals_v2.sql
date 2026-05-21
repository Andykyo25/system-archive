-- v_holdings_signals v2 — Andy 三項微調建議(2026-05-21):
--   1. 長上影規則加振幅 > 1.5% 條件(防止低波動股誤判)
--   2. ❌ 市值分檔:stock_universe / industry_stocks 的 market_cap_billion 全 null,無料可用
--      → 暫保留 vs 0050 ±2pp 單一規則,TODO 等 market_cap 資料補齊後再分檔
--   3. 加新訊號 #13 量價背離(volume_divergence):
--      A. 量縮跌破(假跌破):今 close < 近 5 日最低 close AND 今量 < 5 日均量 * 0.8 → yellow
--      B. 量裂價漲(過高無量):今 close > 近 5 日最高 close AND 今量 < 昨量 * 0.7 → orange
--      C. 量價同步 → green
--      D. price_daily today 還沒寫入(盤中)→ gray「等收盤」(避免早盤誤判)
--
-- L37 append-only 哲學:create or replace view 不 drop / 不 cascade,signals jsonb array 從 12 個變 13 個

create or replace view public.v_holdings_signals as
with base as (
  select
    a.symbol, a.net_qty, a.avg_cost, a.current_price, a.pct_change,
    a.unrealized_pnl,
    a.stop_loss_price, a.add_position_price, a.obs1_price, a.obs2_price, a.force_out_price,
    a.weighted_score, a.expected_rank,
    a.fund_count_pos, a.fund_count_total,
    a.mom_count_pos, a.mom_count_total,
    a.chip_count_pos, a.chip_count_total,
    a.rsi14,
    a.is_entry_signal, a.signal_strength,
    f.ma20_now, f.ma60_now, f.ma200_now,
    f.ret_5d_pct, f.ret_20d_pct, f.ret_60d_pct,
    f.off_high_60d_pct,
    f.lending_latest, f.lending_prev,
    f.foreign_net_3d_sum,
    f.rev_count_pos, f.rev_count_total
  from v_holdings_advice a
  left join v_factor_scores f on f.symbol = a.symbol
),
bench_chg as (
  select coalesce(
    (
      select (i.price / d.close - 1) * 100
      from (
        select price from price_intraday_cache
        where symbol='0050' and quoted_at::date = current_date
        order by quoted_at desc limit 1
      ) i, (
        select close from price_daily
        where symbol='0050' and trade_date < current_date
        order by trade_date desc limit 1
      ) d
    ),
    0
  )::numeric as bench_chg_pct
),
recent5 as (
  select symbol, trade_date, open, high, low, close, volume,
         row_number() over (partition by symbol order by trade_date desc) rn
  from price_daily
  where symbol in (select symbol from base)
    and trade_date > current_date - interval '15 days'
),
-- v2:長上影規則加「振幅 > 1.5%」條件(Andy 建議 1)
--   原本兩條件:上影占 50%+ AND 上影 > 2% close(數學上 implies 振幅 > 2%)
--   加振幅 > 1.5% 是 defense-in-depth(明示語意 + 未來改參數仍守)
tail_stats as (
  select symbol,
    count(*) filter (
      where high is not null and low is not null and open is not null and close is not null
        and open > 0
        and high > low
        and (high - low) / open > 0.015                              -- ← v2 新增:振幅 > 1.5%
        and (high - greatest(open, close)) > (high - low) * 0.5
        and (high - greatest(open, close)) > 0.02 * close
    ) as tail_days_5
  from recent5 where rn <= 5
  group by symbol
),
down_streak as (
  select symbol,
    (
      select count(*) from (
        select close, lag(close) over (order by trade_date) prev_c, rn
        from recent5 r2 where r2.symbol = r.symbol
      ) x
      where rn <= 5 and prev_c is not null and close < prev_c
    ) as down_days_5
  from (select distinct symbol from recent5) r
),
today_kbar as (
  select b.symbol,
    coalesce(
      (select close from price_daily pd where pd.symbol = b.symbol and pd.trade_date = current_date),
      b.current_price
    ) as today_close,
    (select close from price_daily pd
      where pd.symbol = b.symbol and pd.trade_date < current_date
      order by pd.trade_date desc limit 1) as prev_close
  from base b
),
kbar_array as (
  select symbol,
    jsonb_agg(
      jsonb_build_object(
        'd', trade_date::text, 'o', open, 'h', high, 'l', low, 'c', close
      ) order by trade_date
    ) filter (where rn <= 5) as bars5
  from recent5 group by symbol
),
-- v2:量價背離(Andy 建議 3)— 僅在 price_daily 有今日完整資料時觸發
--   (盤中 cache 的 tv 是當下累積,跟「收盤完整量」概念不同,避免早盤誤判)
volume_stats as (
  select b.symbol,
    -- 今日 (today) close + volume(來自 price_daily today;沒有 = 盤中,gray)
    (select close from price_daily pd where pd.symbol = b.symbol and pd.trade_date = current_date) as today_close,
    (select volume from price_daily pd where pd.symbol = b.symbol and pd.trade_date = current_date) as today_volume,
    -- 昨日 volume
    (select volume from price_daily pd where pd.symbol = b.symbol
       and pd.trade_date < current_date order by pd.trade_date desc limit 1) as prev_volume,
    -- 近 5 日 (含今日;若無今日就近 5 個 trading days)
    (select min(close) from (
       select close from price_daily pd where pd.symbol = b.symbol
       order by pd.trade_date desc limit 5
    ) x) as low_5d,
    (select max(close) from (
       select close from price_daily pd where pd.symbol = b.symbol
       order by pd.trade_date desc limit 5
    ) x) as high_5d,
    (select avg(volume) from (
       select volume from price_daily pd where pd.symbol = b.symbol
       order by pd.trade_date desc limit 5
    ) x) as avg_volume_5d
  from base b
)
select
  b.symbol, b.net_qty, b.avg_cost, b.current_price,
  round(b.pct_change::numeric, 2) pct_change,
  b.unrealized_pnl::numeric(12,2) unrealized_pnl,
  b.stop_loss_price, b.add_position_price, b.obs1_price, b.obs2_price, b.force_out_price,
  b.expected_rank, b.weighted_score,
  b.fund_count_pos || '/' || b.fund_count_total as fund_str,
  b.mom_count_pos || '/' || b.mom_count_total as mom_str,
  b.rev_count_pos || '/' || b.rev_count_total as rev_str,
  b.chip_count_pos || '/' || b.chip_count_total as chip_str,
  round(b.rsi14::numeric, 1) rsi14,
  case
    when tk.prev_close is not null and tk.prev_close > 0
    then round(((tk.today_close - tk.prev_close) / tk.prev_close * 100)::numeric, 2)
  end as today_chg_pct,
  round(bc.bench_chg_pct::numeric, 2) bench_chg_pct,
  ts.tail_days_5,
  ds.down_days_5,
  jsonb_build_array(
    jsonb_build_object('key','chip','label','籌碼',
      'level', case
        when b.chip_count_total >= 3 and b.chip_count_pos = b.chip_count_total then 'green'
        when b.chip_count_total >= 3 and b.chip_count_pos >= b.chip_count_total - 1 then 'yellow'
        when b.chip_count_total = 0 then 'gray'
        when b.chip_count_pos = 0 then 'red'
        else 'orange' end,
      'value', b.chip_count_pos || '/' || b.chip_count_total),
    jsonb_build_object('key','mom','label','動能',
      'level', case
        when b.mom_count_total = 0 then 'gray'
        when b.mom_count_pos::numeric / b.mom_count_total >= 0.6 then 'green'
        when b.mom_count_pos::numeric / b.mom_count_total >= 0.4 then 'yellow'
        when b.mom_count_pos::numeric / b.mom_count_total >= 0.2 then 'orange'
        else 'red' end,
      'value', b.mom_count_pos || '/' || b.mom_count_total),
    jsonb_build_object('key','fund','label','基本面',
      'level', case
        when b.fund_count_total = 0 then 'gray'
        when b.fund_count_pos::numeric / b.fund_count_total >= 0.7 then 'green'
        when b.fund_count_pos::numeric / b.fund_count_total >= 0.5 then 'yellow'
        else 'orange' end,
      'value', b.fund_count_pos || '/' || b.fund_count_total),
    jsonb_build_object('key','rsi','label','RSI',
      'level', case
        when b.rsi14 is null then 'gray'
        when b.rsi14 > 80 then 'red'
        when b.rsi14 > 70 then 'yellow'
        when b.rsi14 < 30 then 'orange'
        when b.rsi14 < 50 then 'yellow'
        else 'green' end,
      'value', round(b.rsi14::numeric, 1)::text),
    jsonb_build_object('key','ma_arrange','label','MA排列',
      'level', case
        when b.ma20_now is null or b.ma60_now is null or b.ma200_now is null then 'gray'
        when b.current_price > b.ma20_now and b.ma20_now > b.ma60_now and b.ma60_now > b.ma200_now then 'green'
        when b.current_price > b.ma200_now then 'yellow'
        else 'red' end,
      'value', case
        when b.ma20_now is null then '—'
        when b.current_price > b.ma20_now and b.ma20_now > b.ma60_now and b.ma60_now > b.ma200_now then '完美多頭'
        when b.current_price > b.ma200_now then '部分多頭'
        else '空頭' end),
    jsonb_build_object('key','ma20_dev','label','偏離MA20',
      'level', case
        when b.ma20_now is null or b.ma20_now <= 0 then 'gray'
        when (b.current_price - b.ma20_now) / b.ma20_now > 0.20 then 'red'
        when (b.current_price - b.ma20_now) / b.ma20_now > 0.15 then 'orange'
        when (b.current_price - b.ma20_now) / b.ma20_now > 0.10 then 'yellow'
        when (b.current_price - b.ma20_now) / b.ma20_now < -0.05 then 'orange'
        else 'green' end,
      'value', case when b.ma20_now > 0
        then round(((b.current_price - b.ma20_now) / b.ma20_now * 100)::numeric, 1)::text || '%'
        else '—' end),
    jsonb_build_object('key','stop_buffer','label','距停損',
      'level', case
        when b.stop_loss_price is null or b.current_price is null then 'gray'
        when b.current_price <= b.stop_loss_price then 'red'
        when (b.current_price - b.stop_loss_price) / b.current_price < 0.02 then 'red'
        when (b.current_price - b.stop_loss_price) / b.current_price < 0.05 then 'orange'
        when (b.current_price - b.stop_loss_price) / b.current_price < 0.10 then 'yellow'
        else 'green' end,
      'value', case when b.current_price > 0
        then round(((b.current_price - b.stop_loss_price) / b.current_price * -100)::numeric, 1)::text || '%'
        else '—' end),
    jsonb_build_object('key','obs1_dist','label','距+20%',
      'level', case
        when b.obs1_price is null then 'gray'
        when b.current_price >= b.obs1_price then 'green'
        when (b.obs1_price - b.current_price) / b.current_price < 0.05 then 'yellow'
        else 'gray' end,
      'value', case when b.current_price > 0
        then '+' || round(((b.obs1_price - b.current_price) / b.current_price * 100)::numeric, 1)::text || '%'
        else '—' end),
    jsonb_build_object('key','tail','label','長上影',
      'level', case
        when ts.tail_days_5 >= 3 then 'red'
        when ts.tail_days_5 = 2 then 'orange'
        when ts.tail_days_5 = 1 then 'yellow'
        else 'green' end,
      'value', '近5日 ' || coalesce(ts.tail_days_5, 0)::text || '日'),
    jsonb_build_object('key','down_streak','label','連跌',
      'level', case
        when ds.down_days_5 >= 4 then 'red'
        when ds.down_days_5 = 3 then 'orange'
        when ds.down_days_5 = 2 then 'yellow'
        else 'green' end,
      'value', '近5日 ' || coalesce(ds.down_days_5, 0)::text || '日'),
    -- vs 0050 vs 大盤(v2 TODO:待 market_cap 資料補齊後分檔放寬;目前單一 ±2pp)
    jsonb_build_object('key','vs_bench','label','vs 0050',
      'level', case
        when tk.prev_close is null or tk.prev_close <= 0 then 'gray'
        when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > 2 then 'green'
        when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > -2 then 'yellow'
        when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > -5 then 'orange'
        else 'red' end,
      'value', case when tk.prev_close > 0
        then round((((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct)::numeric, 1)::text || 'pp'
        else '—' end),
    jsonb_build_object('key','ret_60d','label','60日漲幅',
      'level', case
        when b.ret_60d_pct is null then 'gray'
        when b.ret_60d_pct > 80 then 'red'
        when b.ret_60d_pct > 50 then 'orange'
        when b.ret_60d_pct > 30 then 'yellow'
        when b.ret_60d_pct < -20 then 'orange'
        else 'green' end,
      'value', case when b.ret_60d_pct is not null
        then round(b.ret_60d_pct::numeric, 1)::text || '%'
        else '—' end),
    -- 13. 量價背離(v2 新增,Andy 建議 3)
    jsonb_build_object('key','vol_div','label','量價',
      'level', case
        -- price_daily today 沒寫入(盤中)→ gray「等收盤」
        when vs.today_close is null or vs.today_volume is null or vs.avg_volume_5d is null
          then 'gray'
        -- B. 量裂價漲(過高無量):今 close > 近 5 日最高 AND 今量 < 昨量 * 0.7
        when vs.high_5d is not null and vs.today_close >= vs.high_5d
          and vs.prev_volume is not null and vs.prev_volume > 0
          and vs.today_volume::numeric < vs.prev_volume * 0.7
          then 'orange'
        -- A. 量縮跌破(假跌破):今 close < 近 5 日最低 AND 今量 < 5 日均量 * 0.8
        when vs.low_5d is not null and vs.today_close <= vs.low_5d
          and vs.avg_volume_5d > 0
          and vs.today_volume::numeric < vs.avg_volume_5d * 0.8
          then 'yellow'
        else 'green' end,
      'value', case
        when vs.today_close is null or vs.today_volume is null then '盤中·等收盤'
        when vs.high_5d is not null and vs.today_close >= vs.high_5d
          and vs.prev_volume is not null and vs.prev_volume > 0
          and vs.today_volume::numeric < vs.prev_volume * 0.7
          then '過高無量'
        when vs.low_5d is not null and vs.today_close <= vs.low_5d
          and vs.avg_volume_5d > 0
          and vs.today_volume::numeric < vs.avg_volume_5d * 0.8
          then '量縮跌破'
        else '量價同步' end)
  ) as signals,
  case
    when b.current_price is null or b.stop_loss_price is null then 'caution'
    when b.current_price <= b.stop_loss_price
      or (b.current_price - b.stop_loss_price) / b.current_price < 0.02
      or b.rsi14 > 80 then 'alert'
    -- v2:量裂價漲也升 warning(過高無量是反轉強訊號)
    when ts.tail_days_5 >= 2
      or ds.down_days_5 >= 3
      or (b.current_price - b.stop_loss_price) / b.current_price < 0.05
      or (tk.prev_close is not null and tk.prev_close > 0
          and (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) < -5)
      or (b.chip_count_total >= 3 and b.chip_count_pos <= 1)
      or (vs.today_close is not null and vs.high_5d is not null and vs.today_close >= vs.high_5d
          and vs.prev_volume is not null and vs.prev_volume > 0
          and vs.today_volume::numeric < vs.prev_volume * 0.7) then 'warning'
    when b.rsi14 > 70
      or b.ret_60d_pct > 50
      or ts.tail_days_5 = 1
      or (b.ma20_now is not null and b.ma20_now > 0 and (b.current_price - b.ma20_now) / b.ma20_now > 0.15)
      or (b.chip_count_total >= 3 and b.chip_count_pos < b.chip_count_total)
      or (vs.today_close is not null and vs.low_5d is not null and vs.today_close <= vs.low_5d
          and vs.avg_volume_5d > 0 and vs.today_volume::numeric < vs.avg_volume_5d * 0.8) then 'caution'
    else 'healthy'
  end as signal_level,
  rk.bars5
from base b
left join tail_stats ts on ts.symbol = b.symbol
left join down_streak ds on ds.symbol = b.symbol
left join today_kbar tk on tk.symbol = b.symbol
left join kbar_array rk on rk.symbol = b.symbol
left join volume_stats vs on vs.symbol = b.symbol
cross join bench_chg bc;

comment on view public.v_holdings_signals is
  '持股訊號規則層 v2(2026-05-21):
   - 12 訊號 + 新增 #13 量價背離(volume_divergence)
   - 長上影規則加振幅 > 1.5% 條件(防低波動誤判)
   - 量價背離僅 price_daily 有今日 row 時觸發(避免盤中 noise)
   - 量裂價漲升綜合 warning(過高無量是反轉訊號)
   - TODO:market_cap 資料補齊後,vs 大盤分檔放寬門檻(目前單一 vs 0050 ±2pp)';
