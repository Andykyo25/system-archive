-- M10: score_universe_at(as_of_date) — 歷史視角的多因子排名
--
-- 為什麼需要這個 function:
--   既有 v_price_factors / v_chip_factors / v_factor_scores / v_stock_rank 用 current_date,
--   只能算「今天視角」。Backtest 要在 2024-06-01 假設「我站在當天看資料怎麼 rank」,
--   不能讓未來資料汙染。
--
-- 對應關係:
--   v_price_factors  →  CTE price_universe + price_ranked + price_agg(price_daily 過去 180 天)
--   v_chip_factors   →  CTE chip 4 個 left join(法人 / 融資 / 借券 / 集保 14-60 天視窗)
--   v_factor_scores  →  CTE fund + price + chip 合併成 11 factor int + 4 維度 count
--   v_stock_rank     →  CTE weighted + scored,輸出 weighted_score + 4 維度 % + 各 factor
--
-- 對 "as_of_date" 的處理:
--   price_daily:trade_date <= as_of_date
--   fundamentals:period_end <= as_of_date(用最近 8 季)
--   monthly_revenue:period_year*100+period_month <= 對應 as_of_date 的月份
--   institutional / margin / shareholding / lending:trade_date <= as_of_date
--   pe_pb_daily:trade_date <= as_of_date 的最後一筆
--   universe(stock_universe / industry_stocks / watchlist / holdings):當前快照
--     （universe 名單本身不需要歷史化,backtest 想用「現在的選股池」回測歷史是合理的）
--
-- 簽名:returns table(每 symbol 一 row,包含 expected_rank + factor 詳細)
-- 呼叫:select * from score_universe_at('2024-06-01') order by expected_rank limit 10

create or replace function public.score_universe_at(as_of_date date)
returns table (
  symbol text,
  weighted_score numeric,
  expected_rank bigint,
  fund_count_pos int,
  fund_count_total int,
  mom_count_pos int,
  mom_count_total int,
  rev_count_pos int,
  rev_count_total int,
  chip_count_pos int,
  chip_count_total int,
  fund_score_pct numeric,
  mom_score_pct numeric,
  rev_score_pct numeric,
  chip_score_pct numeric,
  latest_close numeric,
  latest_date date,
  ret_20d_pct numeric,
  rsi14 numeric,
  off_high_60d_pct numeric
)
language sql
stable
as $$
with universe_symbols as (
  select symbol from public.stock_universe
  union
  select symbol from public.industry_stocks
  union
  select symbol from public.watchlist
  union
  select symbol from public.holdings_transactions
  union
  select symbol from public.etf_metadata
),
-- ====================== Price ranked (180 day window before as_of_date) ======================
price_ranked as (
  select
    p.symbol, p.trade_date, p.close, p.volume,
    row_number() over (partition by p.symbol order by p.trade_date desc) as rn,
    p.close - lag(p.close) over (partition by p.symbol order by p.trade_date) as price_change
  from public.price_daily p
  inner join universe_symbols u on u.symbol = p.symbol
  where p.trade_date <= as_of_date
    and p.trade_date > as_of_date - interval '180 days'
),
price_agg as (
  select
    symbol,
    max(case when rn = 1 then close end) as latest_close_v,
    max(case when rn = 1 then trade_date end) as latest_date_v,
    max(case when rn = 21 then close end) as close_20d_ago,
    max(case when rn = 61 then close end) as close_60d_ago,
    max(case when rn = 6 then close end) as close_5d_ago,
    avg(case when rn between 1 and 20 then close end) as ma20_now,
    avg(case when rn between 1 and 60 then close end) as ma60_now,
    avg(case when rn between 6 and 25 then close end) as ma20_prev,
    avg(case when rn between 6 and 65 then close end) as ma60_prev,
    max(case when rn between 1 and 60 then close end) as high_60d,
    avg(case when rn between 1 and 5 then volume end) as vol_5d_avg,
    avg(case when rn between 1 and 20 then volume end) as vol_20d_avg,
    sum(case when rn between 1 and 14 and price_change > 0 then price_change else 0 end) as gain_14,
    sum(case when rn between 1 and 14 and price_change < 0 then -price_change else 0 end) as loss_14,
    count(case when rn between 1 and 14 and price_change is not null then 1 end) as rsi_days_available,
    count(case when rn between 1 and 60 then 1 end) as ma60_days_available
  from price_ranked
  group by symbol
),
price as (
  select
    a.symbol,
    a.latest_close_v,
    a.latest_date_v,
    a.ma20_now,
    a.ma60_now,
    case
      when a.rsi_days_available is null or a.rsi_days_available < 13 then null
      when a.loss_14 = 0 and a.gain_14 = 0 then 50::numeric
      when a.loss_14 = 0 then 100::numeric
      else 100 - (100.0 / (1 + (a.gain_14 / a.loss_14)))
    end as rsi14_v,
    case when a.high_60d is not null and a.high_60d > 0
      then ((a.high_60d - a.latest_close_v) / a.high_60d) * 100 end as off_high_60d_pct_v,
    case when a.close_20d_ago is not null and a.close_20d_ago > 0
      then ((a.latest_close_v - a.close_20d_ago) / a.close_20d_ago) * 100 end as ret_20d_pct_v,
    -- factors
    case
      when a.ma60_days_available is null or a.ma60_days_available < 60 then null::int
      when a.ma20_now is null or a.ma60_now is null or a.ma20_prev is null or a.ma60_prev is null
        then null::int
      when a.ma20_now > a.ma60_now and a.ma20_prev <= a.ma60_prev then 1
      else 0
    end as mom_ma_golden,
    case
      when a.close_20d_ago is null or a.close_60d_ago is null
        or a.close_20d_ago <= 0 or a.close_60d_ago <= 0
        then null::int
      when ((a.latest_close_v - a.close_20d_ago) / a.close_20d_ago) > 0
        and ((a.latest_close_v - a.close_20d_ago) / a.close_20d_ago)
            > ((a.latest_close_v - a.close_60d_ago) / a.close_60d_ago) / 3 then 1
      else 0
    end as mom_ret_diff,
    case
      when a.rsi_days_available is null or a.rsi_days_available < 13 then null::int
      when a.loss_14 = 0 and a.gain_14 = 0 then 1
      when a.loss_14 = 0 then 0
      when (100 - (100.0 / (1 + (a.gain_14 / a.loss_14)))) < 70 then 1
      else 0
    end as mom_rsi_ok,
    case
      when a.ma60_days_available is null or a.ma60_days_available < 60 then null::int
      when a.high_60d is null or a.high_60d <= 0 or a.latest_close_v is null then null::int
      when ((a.high_60d - a.latest_close_v) / a.high_60d) > 0.10 then 1
      else 0
    end as rev_off_high,
    case
      when a.close_5d_ago is null or a.close_5d_ago <= 0
        or a.vol_5d_avg is null or a.vol_20d_avg is null or a.vol_20d_avg = 0
        then null::int
      when ((a.latest_close_v - a.close_5d_ago) / a.close_5d_ago) * 100 < -3
        and a.vol_5d_avg < a.vol_20d_avg * 0.85 then 1
      else 0
    end as rev_vol_dry
  from price_agg a
  where a.latest_close_v is not null
),
-- ====================== Chip(法人 / 融資 / 借券 / 集保)======================
inst_recent as (
  select
    i.symbol, i.foreign_net,
    row_number() over (partition by i.symbol order by i.trade_date desc) as rn
  from public.stock_institutional i
  inner join universe_symbols u on u.symbol = i.symbol
  where i.trade_date <= as_of_date
    and i.trade_date > as_of_date - interval '14 days'
),
inst_agg as (
  select
    symbol,
    count(*) filter (where rn <= 3) as inst_days_available,
    bool_and(case when rn <= 3 then foreign_net > 0 end) filter (where rn <= 3) as inst_3d_all_buy
  from inst_recent
  group by symbol
),
margin_recent as (
  select
    m.symbol, m.margin_delta,
    row_number() over (partition by m.symbol order by m.trade_date desc) as rn
  from public.stock_margin m
  inner join universe_symbols u on u.symbol = m.symbol
  where m.trade_date <= as_of_date
    and m.trade_date > as_of_date - interval '14 days'
),
margin_agg as (
  select
    symbol,
    count(*) filter (where rn <= 5) as margin_days_available,
    sum(case when rn <= 5 then margin_delta end) as margin_delta_5d_sum
  from margin_recent
  group by symbol
),
lending_recent as (
  select
    l.symbol, l.daily_lending_volume,
    row_number() over (partition by l.symbol order by l.trade_date desc) as rn
  from public.v_securities_lending_daily l
  inner join universe_symbols u on u.symbol = l.symbol
  where l.trade_date <= as_of_date
    and l.trade_date > as_of_date - interval '14 days'
),
lending_agg as (
  select
    symbol,
    max(case when rn = 1 then daily_lending_volume end) as lending_latest,
    max(case when rn = 2 then daily_lending_volume end) as lending_prev
  from lending_recent
  group by symbol
),
share_recent as (
  select
    s.symbol, s.foreign_holding_ratio,
    row_number() over (partition by s.symbol order by s.report_date desc) as rn
  from public.stock_shareholding s
  inner join universe_symbols u on u.symbol = s.symbol
  where s.report_date <= as_of_date
    and s.report_date > as_of_date - interval '60 days'
),
share_agg as (
  select
    symbol,
    max(case when rn = 1 then foreign_holding_ratio end) as foreign_ratio_latest,
    max(case when rn = 2 then foreign_holding_ratio end) as foreign_ratio_prev
  from share_recent
  group by symbol
),
chip as (
  select
    u.symbol,
    case
      when ia.inst_days_available is null or ia.inst_days_available < 3 then null::int
      when ia.inst_3d_all_buy then 1 else 0
    end as chip_foreign_3d_buy,
    case
      when ma.margin_days_available is null or ma.margin_days_available < 3 then null::int
      when ma.margin_delta_5d_sum < 0 then 1 else 0
    end as chip_margin_drop,
    case
      when la.lending_latest is null or la.lending_prev is null then null::int
      when la.lending_latest < la.lending_prev then 1 else 0
    end as chip_lending_drop,
    case
      when sa.foreign_ratio_latest is null or sa.foreign_ratio_prev is null then null::int
      when sa.foreign_ratio_latest > sa.foreign_ratio_prev then 1 else 0
    end as chip_share_concentrate
  from universe_symbols u
  left join inst_agg ia on ia.symbol = u.symbol
  left join margin_agg ma on ma.symbol = u.symbol
  left join lending_agg la on la.symbol = u.symbol
  left join share_agg sa on sa.symbol = u.symbol
),
-- ====================== Fundamentals(以 as_of_date 之前最後 8 季)======================
fund_ranked as (
  select symbol, period_end, eps, net_income, fcf, total_equity,
    row_number() over (partition by symbol order by period_end desc) as q_rn
  from public.stock_fundamentals_quarterly
  where period_end <= as_of_date
),
fund_agg as (
  select
    symbol,
    sum(case when q_rn between 1 and 4 then net_income end) as net_income_ttm,
    sum(case when q_rn between 1 and 4 then fcf end) as fcf_ttm,
    sum(case when q_rn between 1 and 4 then eps end) as eps_ttm,
    sum(case when q_rn between 5 and 8 then eps end) as eps_ttm_prev,
    sum(case when q_rn = 1 then eps end) as eps_q1,
    sum(case when q_rn = 5 then eps end) as eps_q5,
    count(case when q_rn between 1 and 8 and eps > 0 then 1 end) as eps_pos_quarters,
    count(case when q_rn between 1 and 8 then 1 end) as quarters_available
  from fund_ranked
  group by symbol
),
latest_equity as (
  select symbol, total_equity from fund_ranked where q_rn = 1
),
-- valuation(pe/pb)用 as_of_date 之前最後一筆
latest_valuation as (
  select distinct on (symbol) symbol, pe, pb
  from public.stock_pe_pb_daily
  where trade_date <= as_of_date
  order by symbol, trade_date desc
),
-- monthly_revenue:取 as_of_date 月份之前最後 13 筆
rev_ranked as (
  select symbol, period_year, period_month, revenue,
    row_number() over (partition by symbol order by period_year desc, period_month desc) as m_rn
  from public.stock_monthly_revenue
  where (period_year * 100 + period_month) <= (extract(year from as_of_date)::int * 100 + extract(month from as_of_date)::int)
),
rev_agg as (
  select
    symbol,
    max(case when m_rn = 1 then revenue end) as latest_revenue,
    max(case when m_rn = 13 then revenue end) as latest_revenue_prev_year
  from rev_ranked
  where m_rn <= 13
  group by symbol
),
-- 6 個 fundamental factors,語意對應 v_factor_scores fund:
fund as (
  select
    fa.symbol,
    -- f1:過去 4 季 EPS 皆 > 0(需資料量達 4)
    case
      when fa.quarters_available is null or fa.quarters_available < 4 then null::int
      when fa.eps_pos_quarters >= 4 then 1
      else 0
    end as fund_eps_pos,
    -- f2:last_q EPS YoY > 0(用 q1 vs q5)
    case
      when fa.eps_q5 is null or abs(fa.eps_q5) = 0 then
        case
          when fa.eps_ttm_prev is null or abs(fa.eps_ttm_prev) = 0 then null::int
          when ((fa.eps_ttm - fa.eps_ttm_prev) / abs(fa.eps_ttm_prev)) > 0 then 1
          else 0
        end
      when ((fa.eps_q1 - fa.eps_q5) / abs(fa.eps_q5)) > 0 then 1
      else 0
    end as fund_eps_yoy,
    -- f3:ROE > 15%(net_income_ttm / total_equity × 100)
    case
      when le.total_equity is null or le.total_equity <= 0 or fa.net_income_ttm is null then null::int
      when (fa.net_income_ttm / le.total_equity) * 100 > 15 then 1 else 0
    end as fund_roe_high,
    -- f4:FCF (TTM) > 0
    case
      when fa.fcf_ttm is null then null::int
      when fa.fcf_ttm > 0 then 1 else 0
    end as fund_fcf_pos,
    -- f5:PEG < 1(以 last_q YoY 估,簡化版)
    case
      when lv.pe is null or lv.pe <= 0 then null::int
      when fa.eps_q5 is null or fa.eps_q5 <= 0 or fa.eps_q1 is null then null::int
      when fa.eps_q1 <= fa.eps_q5 then 0  -- 沒成長,PEG 不算過關
      else case
        when (lv.pe / (((fa.eps_q1 - fa.eps_q5) / fa.eps_q5) * 100)) < 1 then 1
        else 0
      end
    end as fund_peg_low,
    -- f6:月營收 YoY > 0
    case
      when ra.latest_revenue is null or ra.latest_revenue_prev_year is null
        or ra.latest_revenue_prev_year <= 0 then null::int
      when ((ra.latest_revenue - ra.latest_revenue_prev_year) / ra.latest_revenue_prev_year) * 100 > 0 then 1
      else 0
    end as fund_rev_yoy
  from fund_agg fa
  left join latest_equity le on le.symbol = fa.symbol
  left join latest_valuation lv on lv.symbol = fa.symbol
  left join rev_agg ra on ra.symbol = fa.symbol
),
-- ====================== Combine -> count_pos / count_total ======================
combined as (
  select
    u.symbol,
    f.fund_eps_pos, f.fund_eps_yoy, f.fund_roe_high,
    f.fund_fcf_pos, f.fund_peg_low, f.fund_rev_yoy,
    p.mom_ma_golden, p.mom_ret_diff, p.mom_rsi_ok,
    p.rev_off_high, p.rev_vol_dry,
    c.chip_foreign_3d_buy, c.chip_margin_drop,
    c.chip_lending_drop, c.chip_share_concentrate,
    p.latest_close_v, p.latest_date_v,
    p.ret_20d_pct_v, p.rsi14_v, p.off_high_60d_pct_v
  from universe_symbols u
  left join fund f on f.symbol = u.symbol
  left join price p on p.symbol = u.symbol
  left join chip c on c.symbol = u.symbol
),
scored as (
  select
    c.*,
    coalesce(case when c.fund_eps_pos = 1 then 1 else 0 end, 0)
      + coalesce(case when c.fund_eps_yoy = 1 then 1 else 0 end, 0)
      + coalesce(case when c.fund_roe_high = 1 then 1 else 0 end, 0)
      + coalesce(case when c.fund_fcf_pos = 1 then 1 else 0 end, 0)
      + coalesce(case when c.fund_peg_low = 1 then 1 else 0 end, 0)
      + coalesce(case when c.fund_rev_yoy = 1 then 1 else 0 end, 0) as fund_count_pos_v,
    (case when c.fund_eps_pos is not null then 1 else 0 end
      + case when c.fund_eps_yoy is not null then 1 else 0 end
      + case when c.fund_roe_high is not null then 1 else 0 end
      + case when c.fund_fcf_pos is not null then 1 else 0 end
      + case when c.fund_peg_low is not null then 1 else 0 end
      + case when c.fund_rev_yoy is not null then 1 else 0 end) as fund_count_total_v,
    coalesce(case when c.mom_ma_golden = 1 then 1 else 0 end, 0)
      + coalesce(case when c.mom_ret_diff = 1 then 1 else 0 end, 0)
      + coalesce(case when c.mom_rsi_ok = 1 then 1 else 0 end, 0) as mom_count_pos_v,
    (case when c.mom_ma_golden is not null then 1 else 0 end
      + case when c.mom_ret_diff is not null then 1 else 0 end
      + case when c.mom_rsi_ok is not null then 1 else 0 end) as mom_count_total_v,
    coalesce(case when c.rev_off_high = 1 then 1 else 0 end, 0)
      + coalesce(case when c.rev_vol_dry = 1 then 1 else 0 end, 0) as rev_count_pos_v,
    (case when c.rev_off_high is not null then 1 else 0 end
      + case when c.rev_vol_dry is not null then 1 else 0 end) as rev_count_total_v,
    coalesce(case when c.chip_foreign_3d_buy = 1 then 1 else 0 end, 0)
      + coalesce(case when c.chip_margin_drop = 1 then 1 else 0 end, 0)
      + coalesce(case when c.chip_lending_drop = 1 then 1 else 0 end, 0)
      + coalesce(case when c.chip_share_concentrate = 1 then 1 else 0 end, 0) as chip_count_pos_v,
    (case when c.chip_foreign_3d_buy is not null then 1 else 0 end
      + case when c.chip_margin_drop is not null then 1 else 0 end
      + case when c.chip_lending_drop is not null then 1 else 0 end
      + case when c.chip_share_concentrate is not null then 1 else 0 end) as chip_count_total_v
  from combined c
),
weighted as (
  select
    s.*,
    case when s.fund_count_total_v > 0 then 0.50::numeric else 0::numeric end as eff_w_fund,
    case when s.mom_count_total_v  > 0 then 0.25::numeric else 0::numeric end as eff_w_mom,
    case when s.rev_count_total_v  > 0 then 0.15::numeric else 0::numeric end as eff_w_rev,
    case when s.chip_count_total_v > 0 then 0.10::numeric else 0::numeric end as eff_w_chip
  from scored s
),
final_score as (
  select
    w.*,
    (w.eff_w_fund + w.eff_w_mom + w.eff_w_rev + w.eff_w_chip) as total_eff_w,
    case
      when (w.eff_w_fund + w.eff_w_mom + w.eff_w_rev + w.eff_w_chip) = 0 then null::numeric
      else (
        (case when w.fund_count_total_v > 0 then w.fund_count_pos_v::numeric / w.fund_count_total_v else 0 end) * w.eff_w_fund
        + (case when w.mom_count_total_v  > 0 then w.mom_count_pos_v::numeric  / w.mom_count_total_v  else 0 end) * w.eff_w_mom
        + (case when w.rev_count_total_v  > 0 then w.rev_count_pos_v::numeric  / w.rev_count_total_v  else 0 end) * w.eff_w_rev
        + (case when w.chip_count_total_v > 0 then w.chip_count_pos_v::numeric / w.chip_count_total_v else 0 end) * w.eff_w_chip
      ) / (w.eff_w_fund + w.eff_w_mom + w.eff_w_rev + w.eff_w_chip) * 100
    end as ws
  from weighted w
)
select
  fs.symbol,
  fs.ws as weighted_score,
  row_number() over (order by fs.ws desc nulls last, fs.symbol asc) as expected_rank,
  fs.fund_count_pos_v as fund_count_pos,
  fs.fund_count_total_v as fund_count_total,
  fs.mom_count_pos_v as mom_count_pos,
  fs.mom_count_total_v as mom_count_total,
  fs.rev_count_pos_v as rev_count_pos,
  fs.rev_count_total_v as rev_count_total,
  fs.chip_count_pos_v as chip_count_pos,
  fs.chip_count_total_v as chip_count_total,
  case when fs.fund_count_total_v > 0
    then (fs.fund_count_pos_v::numeric / fs.fund_count_total_v) * 100 end as fund_score_pct,
  case when fs.mom_count_total_v > 0
    then (fs.mom_count_pos_v::numeric / fs.mom_count_total_v) * 100 end as mom_score_pct,
  case when fs.rev_count_total_v > 0
    then (fs.rev_count_pos_v::numeric / fs.rev_count_total_v) * 100 end as rev_score_pct,
  case when fs.chip_count_total_v > 0
    then (fs.chip_count_pos_v::numeric / fs.chip_count_total_v) * 100 end as chip_score_pct,
  fs.latest_close_v as latest_close,
  fs.latest_date_v as latest_date,
  fs.ret_20d_pct_v as ret_20d_pct,
  fs.rsi14_v as rsi14,
  fs.off_high_60d_pct_v as off_high_60d_pct
from final_score fs;
$$;

revoke execute on function public.score_universe_at(date) from public, anon, authenticated;
grant execute on function public.score_universe_at(date) to service_role;

comment on function public.score_universe_at(date) is
  'M10 backtest 用:重現 v_stock_rank 的歷史視角版本。
   parametrize as_of_date,所有 price_daily / institutional / margin / lending / shareholding
   / fundamentals / monthly_revenue / pe_pb_daily 都 filter trade_date <= as_of_date。
   universe(stock_universe / industry / watchlist / holdings / etf)用當前快照(不歷史化)。
   只 service_role 可呼叫。';
