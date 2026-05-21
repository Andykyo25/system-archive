-- v_holdings_signals — 持股訊號規則層(純規則,零 LLM,零外部依賴)
--
-- 目的:把「持股當下訊號」結構化、可審計、可在 UI + Telegram 一致顯示。
--   12 個訊號維度 + 綜合 signal_level + 規則建議文字 + 近 5 日 K 線 jsonb。
--
-- 訊號等級(由弱到強):
--   gray:資料不足 / N/A
--   green:健康
--   yellow:輕度注意
--   orange:警告
--   red:警報
--
-- signal_level 綜合(任一觸發升級):
--   alert:停損 buffer < 2% / RSI > 80 / 距停損已破
--   warning:長上影 ≥ 2 日 / 連跌 ≥ 3 日 / vs 大盤大幅落後 > 5pp / chip 翻至 ≤ 1/4
--   caution:RSI 70-80 / 60d > 50% / 長上影 1 日 / chip 退到 ≤ 半 / 偏離 MA20 > 15%
--   healthy:其他
--
-- 用法:
--   /holdings UI:讀 signals jsonb 渲染訊號燈、讀 rule_advice 顯示規則建議
--   notify-holdings-telegram EF:讀 signal_level / signals / rule_advice 組 Markdown 推播

create or replace view public.v_holdings_signals as
with base as (
  -- 持股核心欄位(advice + factor_scores 合一)
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
-- 今日大盤(0050)漲跌幅:即時 cache vs 昨收
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
-- 近 5 個交易日 K(每持股):算長上影、連跌、近期 OHL 給前端
recent5 as (
  select symbol, trade_date, open, high, low, close,
         row_number() over (partition by symbol order by trade_date desc) rn
  from price_daily
  where symbol in (select symbol from base)
    and trade_date > current_date - interval '15 days'
),
-- 長上影天數(近 5 日,上影占全 range > 50% 且上影 > 2% close)
tail_stats as (
  select symbol,
    count(*) filter (
      where high is not null and low is not null and open is not null and close is not null
        and high > low
        and (high - greatest(open, close)) > (high - low) * 0.5
        and (high - greatest(open, close)) > 0.02 * close
    ) as tail_days_5
  from recent5 where rn <= 5
  group by symbol
),
-- 連續下跌天數(從最近一日往前數,連續 close 比前一日低)
down_streak as (
  select symbol,
    (
      -- 用窗函數找最長尾段連跌
      select count(*) from (
        select close, lag(close) over (order by trade_date) prev_c, rn
        from recent5 r2 where r2.symbol = r.symbol
      ) x
      where rn <= 5 and prev_c is not null and close < prev_c
    ) as down_days_5
  from (select distinct symbol from recent5) r
),
-- 今日 K 棒(若有 today price_daily 就用,否則用 cache 推算)
today_kbar as (
  select b.symbol,
    coalesce(
      (select close from price_daily pd where pd.symbol = b.symbol and pd.trade_date = current_date),
      b.current_price
    ) as today_close,
    -- 取昨日 close 算「今日 chg vs 昨日」
    (select close from price_daily pd
      where pd.symbol = b.symbol and pd.trade_date < current_date
      order by pd.trade_date desc limit 1) as prev_close
  from base b
),
-- 近 5 日 K 線陣列(給前端 K 棒視覺化用,5 筆 ASC)
kbar_array as (
  select symbol,
    jsonb_agg(
      jsonb_build_object(
        'd', trade_date::text, 'o', open, 'h', high, 'l', low, 'c', close
      ) order by trade_date
    ) filter (where rn <= 5) as bars5
  from recent5 group by symbol
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
  -- 今日對昨收 chg(若有今日 price_daily 用,否則用 current_price)
  case
    when tk.prev_close is not null and tk.prev_close > 0
    then round(((tk.today_close - tk.prev_close) / tk.prev_close * 100)::numeric, 2)
  end as today_chg_pct,
  round(bc.bench_chg_pct::numeric, 2) bench_chg_pct,
  ts.tail_days_5,
  ds.down_days_5,

  -- 12 個訊號 jsonb array(前端迭代渲染)
  jsonb_build_array(

    -- 1. 籌碼(chip 4/4 滿分為強訊號)
    jsonb_build_object(
      'key', 'chip', 'label', '籌碼',
      'level', case
        when b.chip_count_total >= 3 and b.chip_count_pos = b.chip_count_total then 'green'
        when b.chip_count_total >= 3 and b.chip_count_pos >= b.chip_count_total - 1 then 'yellow'
        when b.chip_count_total = 0 then 'gray'
        when b.chip_count_pos = 0 then 'red'
        else 'orange'
      end,
      'value', b.chip_count_pos || '/' || b.chip_count_total
    ),

    -- 2. 動能
    jsonb_build_object(
      'key', 'mom', 'label', '動能',
      'level', case
        when b.mom_count_total = 0 then 'gray'
        when b.mom_count_pos::numeric / b.mom_count_total >= 0.6 then 'green'
        when b.mom_count_pos::numeric / b.mom_count_total >= 0.4 then 'yellow'
        when b.mom_count_pos::numeric / b.mom_count_total >= 0.2 then 'orange'
        else 'red'
      end,
      'value', b.mom_count_pos || '/' || b.mom_count_total
    ),

    -- 3. 基本面
    jsonb_build_object(
      'key', 'fund', 'label', '基本面',
      'level', case
        when b.fund_count_total = 0 then 'gray'
        when b.fund_count_pos::numeric / b.fund_count_total >= 0.7 then 'green'
        when b.fund_count_pos::numeric / b.fund_count_total >= 0.5 then 'yellow'
        else 'orange'
      end,
      'value', b.fund_count_pos || '/' || b.fund_count_total
    ),

    -- 4. RSI 等級
    jsonb_build_object(
      'key', 'rsi', 'label', 'RSI',
      'level', case
        when b.rsi14 is null then 'gray'
        when b.rsi14 > 80 then 'red'
        when b.rsi14 > 70 then 'yellow'
        when b.rsi14 < 30 then 'orange'
        when b.rsi14 < 50 then 'yellow'
        else 'green'
      end,
      'value', round(b.rsi14::numeric, 1)::text
    ),

    -- 5. MA 排列(完美多頭 = close > MA20 > MA60 > MA200)
    jsonb_build_object(
      'key', 'ma_arrange', 'label', 'MA排列',
      'level', case
        when b.ma20_now is null or b.ma60_now is null or b.ma200_now is null then 'gray'
        when b.current_price > b.ma20_now and b.ma20_now > b.ma60_now and b.ma60_now > b.ma200_now then 'green'
        when b.current_price > b.ma200_now then 'yellow'
        else 'red'
      end,
      'value', case
        when b.ma20_now is null then '—'
        when b.current_price > b.ma20_now and b.ma20_now > b.ma60_now and b.ma60_now > b.ma200_now then '完美多頭'
        when b.current_price > b.ma200_now then '部分多頭'
        else '空頭'
      end
    ),

    -- 6. 偏離 MA20(短期過熱訊號;> 15% 偏離大)
    jsonb_build_object(
      'key', 'ma20_dev', 'label', '偏離MA20',
      'level', case
        when b.ma20_now is null or b.ma20_now <= 0 then 'gray'
        when (b.current_price - b.ma20_now) / b.ma20_now > 0.20 then 'red'
        when (b.current_price - b.ma20_now) / b.ma20_now > 0.15 then 'orange'
        when (b.current_price - b.ma20_now) / b.ma20_now > 0.10 then 'yellow'
        when (b.current_price - b.ma20_now) / b.ma20_now < -0.05 then 'orange'
        else 'green'
      end,
      'value', case when b.ma20_now > 0
        then round(((b.current_price - b.ma20_now) / b.ma20_now * 100)::numeric, 1)::text || '%'
        else '—' end
    ),

    -- 7. 距停損 buffer
    jsonb_build_object(
      'key', 'stop_buffer', 'label', '距停損',
      'level', case
        when b.stop_loss_price is null or b.current_price is null then 'gray'
        when b.current_price <= b.stop_loss_price then 'red'
        when (b.current_price - b.stop_loss_price) / b.current_price < 0.02 then 'red'
        when (b.current_price - b.stop_loss_price) / b.current_price < 0.05 then 'orange'
        when (b.current_price - b.stop_loss_price) / b.current_price < 0.10 then 'yellow'
        else 'green'
      end,
      'value', case when b.current_price > 0
        then round(((b.current_price - b.stop_loss_price) / b.current_price * -100)::numeric, 1)::text || '%'
        else '—' end
    ),

    -- 8. 距 obs1(+20%)觀察點
    jsonb_build_object(
      'key', 'obs1_dist', 'label', '距+20%',
      'level', case
        when b.obs1_price is null then 'gray'
        when b.current_price >= b.obs1_price then 'green'
        when (b.obs1_price - b.current_price) / b.current_price < 0.05 then 'yellow'
        else 'gray'
      end,
      'value', case when b.current_price > 0
        then '+' || round(((b.obs1_price - b.current_price) / b.current_price * 100)::numeric, 1)::text || '%'
        else '—' end
    ),

    -- 9. 長上影警示(近 5 日)
    jsonb_build_object(
      'key', 'tail', 'label', '長上影',
      'level', case
        when ts.tail_days_5 >= 3 then 'red'
        when ts.tail_days_5 = 2 then 'orange'
        when ts.tail_days_5 = 1 then 'yellow'
        else 'green'
      end,
      'value', '近5日 ' || coalesce(ts.tail_days_5, 0)::text || '日'
    ),

    -- 10. 連跌天數
    jsonb_build_object(
      'key', 'down_streak', 'label', '連跌',
      'level', case
        when ds.down_days_5 >= 4 then 'red'
        when ds.down_days_5 = 3 then 'orange'
        when ds.down_days_5 = 2 then 'yellow'
        else 'green'
      end,
      'value', '近5日 ' || coalesce(ds.down_days_5, 0)::text || '日'
    ),

    -- 11. vs 大盤(今日個股 chg − 0050 chg)
    jsonb_build_object(
      'key', 'vs_bench', 'label', 'vs 0050',
      'level', case
        when tk.prev_close is null or tk.prev_close <= 0 then 'gray'
        when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > 2 then 'green'
        when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > -2 then 'yellow'
        when (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) > -5 then 'orange'
        else 'red'
      end,
      'value', case when tk.prev_close > 0
        then round((((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct)::numeric, 1)::text || 'pp'
        else '—' end
    ),

    -- 12. 60日漲幅警示(> 50% 均值回歸壓力)
    jsonb_build_object(
      'key', 'ret_60d', 'label', '60日漲幅',
      'level', case
        when b.ret_60d_pct is null then 'gray'
        when b.ret_60d_pct > 80 then 'red'
        when b.ret_60d_pct > 50 then 'orange'
        when b.ret_60d_pct > 30 then 'yellow'
        when b.ret_60d_pct < -20 then 'orange'
        else 'green'
      end,
      'value', case when b.ret_60d_pct is not null
        then round(b.ret_60d_pct::numeric, 1)::text || '%'
        else '—' end
    )

  ) as signals,

  -- 綜合 signal_level
  case
    -- alert
    when b.current_price is null or b.stop_loss_price is null then 'caution'
    when b.current_price <= b.stop_loss_price
      or (b.current_price - b.stop_loss_price) / b.current_price < 0.02
      or b.rsi14 > 80 then 'alert'
    -- warning
    when ts.tail_days_5 >= 2
      or ds.down_days_5 >= 3
      or (b.current_price - b.stop_loss_price) / b.current_price < 0.05
      or (tk.prev_close is not null and tk.prev_close > 0
          and (((tk.today_close - tk.prev_close) / tk.prev_close * 100) - bc.bench_chg_pct) < -5)
      or (b.chip_count_total >= 3 and b.chip_count_pos <= 1) then 'warning'
    -- caution
    when b.rsi14 > 70
      or b.ret_60d_pct > 50
      or ts.tail_days_5 = 1
      or (b.ma20_now is not null and b.ma20_now > 0 and (b.current_price - b.ma20_now) / b.ma20_now > 0.15)
      or (b.chip_count_total >= 3 and b.chip_count_pos < b.chip_count_total) then 'caution'
    else 'healthy'
  end as signal_level,

  rk.bars5
from base b
left join tail_stats ts on ts.symbol = b.symbol
left join down_streak ds on ds.symbol = b.symbol
left join today_kbar tk on tk.symbol = b.symbol
left join kbar_array rk on rk.symbol = b.symbol
cross join bench_chg bc;

comment on view public.v_holdings_signals is
  '持股訊號規則層(純規則,L1+L2,零 LLM)。
   12 個訊號維度 + 綜合 signal_level + 近 5 日 K 線 jsonb。
   給 /holdings UI 訊號燈渲染 + notify-holdings-telegram EF 推播用。
   訊號等級:green/yellow/orange/red/gray;signal_level:healthy/caution/warning/alert。';
