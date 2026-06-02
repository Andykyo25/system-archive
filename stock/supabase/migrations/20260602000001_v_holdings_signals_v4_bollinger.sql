-- v_holdings_signals v4 — 加 #15 布林位置(2026-06-02,Andy 走 B:資訊呈現不當買賣訊號):
--   #15 boll 布林軌道(標準 20/2,adj_close)— %B 位置 + 近軌/破軌 yellow 中性提醒。
--   不進 signal_level、不參與排名。均值回歸對抱趨勢股會太早喊賣,只當參考(同 L36 精神)。
--   append-only:14 → 15 element,不動現有 14 訊號邏輯與 signal_level 主規則。
--
-- v_holdings_signals v3 — Andy 建議 2 完整實作(2026-05-31):
--
-- 對比 v2 變更:
--   1. #11 vs_bench:依市值分檔調整門檻
--      - v2:全部 ±2pp / -5pp / red 一視同仁
--      - v3:權值股本來就跟 0050 高度連動,日差 ±1pp 內算齊步;
--             小型股獨立行情,日差 ±3pp 內才算「沒掉隊」
--             | 分檔 | green | yellow | orange | red |
--             |---|---|---|---|---|
--             | 權值 >3000億 | >+1pp | >-1pp | >-3pp | else |
--             | 中型 300-3000億 | >+2pp | >-2pp | >-5pp | else |
--             | 小型 <300億 | >+3pp | >-3pp | >-8pp | else |
--             | null(ETF/缺料) | 沿用中型 |
--   2. 新增 #14 mcap_tier(市值分檔)— 純資訊 gray,顯示「權值 5198億」「中型 1200億」「小型 280億」
--
-- 14 個訊號(原 13 → 加 1)。L37 append-only,jsonb_build_array 從 13 element 變 14。
-- 不動其他 12 個訊號邏輯,不動 signal_level 主規則。
--
-- 解鎖前提:stock_universe.market_cap_billion 已 backfill(2026-05-21 migration 003)。

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
    f.rev_count_pos, f.rev_count_total,
    su.market_cap_billion as mcap_b                                 -- ← v3 新增
  from v_holdings_advice a
  left join v_factor_scores f on f.symbol = a.symbol
  left join stock_universe su on su.symbol = a.symbol               -- ← v3 新增
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
tail_stats as (
  select symbol,
    count(*) filter (
      where high is not null and low is not null and open is not null and close is not null
        and open > 0
        and high > low
        and (high - low) / open > 0.015
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
volume_stats as (
  select b.symbol,
    (select close from price_daily pd where pd.symbol = b.symbol and pd.trade_date = current_date) as today_close,
    (select volume from price_daily pd where pd.symbol = b.symbol and pd.trade_date = current_date) as today_volume,
    (select volume from price_daily pd where pd.symbol = b.symbol
       and pd.trade_date < current_date order by pd.trade_date desc limit 1) as prev_volume,
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
),
boll as (
  -- 布林軌道(標準 20/2,不調參):MA20 ± 2σ,用 adj_close(close*adj_factor)還原權值,
  -- 與 ma20_dev 訊號同口徑(A5:adj_factor[最近]=1 時 raw current 與 adj MA 同基準)。
  -- 純資訊呈現「現價在通道位置」,不進 signal_level、不當買賣訊號(走 B:均值回歸對抱
  -- 趨勢股會太早喊賣,故只當參考,同 L36 精神)。
  select symbol,
    avg(adj_c) + 2 * stddev_samp(adj_c) as upper,
    avg(adj_c) - 2 * stddev_samp(adj_c) as lower
  from (
    select symbol, close * coalesce(adj_factor, 1) as adj_c,
      row_number() over (partition by symbol order by trade_date desc) as rn
    from price_daily
    where symbol in (select symbol from base) and close > 0
  ) x
  where rn <= 20
  group by symbol
  having count(*) >= 20
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
    -- v3: #11 vs_bench 依市值分檔
    --   權值 >3000億:±1pp / -3pp / red
    --   中型 300-3000億 / null:±2pp / -5pp / red(沿用 v2)
    --   小型 <300億:±3pp / -8pp / red
    jsonb_build_object('key','vs_bench','label','vs 0050',
      'level', case
        when tk.prev_close is null or tk.prev_close <= 0 then 'gray'
        -- 權值股(嚴)
        when b.mcap_b > 3000 then case
          when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > 1 then 'green'
          when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > -1 then 'yellow'
          when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > -3 then 'orange'
          else 'red' end
        -- 小型股(寬)
        when b.mcap_b is not null and b.mcap_b < 300 then case
          when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > 3 then 'green'
          when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > -3 then 'yellow'
          when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > -8 then 'orange'
          else 'red' end
        -- 中型 / null:沿用 v2 ±2pp / -5pp
        else case
          when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > 2 then 'green'
          when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > -2 then 'yellow'
          when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > -5 then 'orange'
          else 'red' end
        end,
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
    jsonb_build_object('key','vol_div','label','量價',
      'level', case
        when vs.today_close is null or vs.today_volume is null or vs.avg_volume_5d is null
          then 'gray'
        when vs.high_5d is not null and vs.today_close >= vs.high_5d
          and vs.prev_volume is not null and vs.prev_volume > 0
          and vs.today_volume::numeric < vs.prev_volume * 0.7
          then 'orange'
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
        else '量價同步' end),
    -- 14. 市值分檔(v3 新增,Andy 建議 2)— 純資訊 gray
    jsonb_build_object('key','mcap_tier','label','市值',
      'level', 'gray',
      'value', case
        when b.mcap_b is null then '—(ETF/缺料)'
        when b.mcap_b > 3000 then '權值 ' || round(b.mcap_b, 0)::text || '億'
        when b.mcap_b > 300 then '中型 ' || round(b.mcap_b, 0)::text || '億'
        else '小型 ' || round(b.mcap_b, 0)::text || '億'
        end),
    -- 15. 布林位置(走 B:資訊呈現,不當買賣訊號)。%B=(現價-下軌)/(上軌-下軌)。
    --     中段 gray;近軌/破軌 yellow(中性提醒在邊緣,不指買賣方向 — 趨勢股沿上軌走屬正常)
    jsonb_build_object('key','boll','label','布林位置',
      'level', case
        when bl.upper is null or bl.lower is null or bl.upper <= bl.lower or b.current_price is null then 'gray'
        when (b.current_price - bl.lower) / (bl.upper - bl.lower) >= 0.8
          or (b.current_price - bl.lower) / (bl.upper - bl.lower) <= 0.2 then 'yellow'
        else 'gray' end,
      'value', case
        when bl.upper is null or bl.lower is null or bl.upper <= bl.lower or b.current_price is null then '—'
        else (case
            when b.current_price > bl.upper then '破上軌'
            when b.current_price < bl.lower then '破下軌'
            when (b.current_price - bl.lower) / (bl.upper - bl.lower) >= 0.8 then '近上軌'
            when (b.current_price - bl.lower) / (bl.upper - bl.lower) <= 0.2 then '近下軌'
            else '中段' end)
          || '·'
          || round(((b.current_price - bl.lower) / (bl.upper - bl.lower) * 100)::numeric, 0)::text || '%'
        end)
  ) as signals,
  case
    when b.current_price is null or b.stop_loss_price is null then 'caution'
    when b.current_price <= b.stop_loss_price
      or (b.current_price - b.stop_loss_price) / b.current_price < 0.02
      or b.rsi14 > 80 then 'alert'
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
left join boll bl on bl.symbol = b.symbol
cross join bench_chg bc;

comment on view public.v_holdings_signals is
  '持股訊號規則層 v4(2026-06-02):
   - 15 訊號(v3 14 → 加 #15 布林位置,Andy 走 B 資訊呈現)
   - #15 boll:布林標準 20/2(adj_close),%B 位置,近軌/破軌 yellow 中性提醒,不進 signal_level
   - 14 訊號(原 13 → 加 #14 市值分檔)
   - #11 vs_bench 依市值分檔調整門檻:權值嚴(±1pp)/ 中型中(±2pp)/ 小型寬(±3pp)
   - #14 mcap_tier 純資訊 gray:權值 >3000億 / 中型 300-3000億 / 小型 <300億
   - 不動其他 12 訊號邏輯,不動 signal_level 主規則
   - 依賴 stock_universe.market_cap_billion(2026-05-21 backfill)';
