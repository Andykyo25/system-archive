-- M9: 籌碼因子(全從 M8 新表算)
--
-- 4 個 boolean factor + 對應輔助欄供 UI 顯示:
--   chip_foreign_3d_buy   法人連續 3 日買超
--   chip_margin_drop      近 5 日融資餘額 net 減少(散戶離場 = 反指標)
--   chip_lending_drop     最近一日借券總量 < 前一日(空單回補)
--   chip_share_concentrate 最新週外資持股比例 > 前一週(大戶集中)
--
-- 空資料 graceful:
--   每個 factor 都會 case when 資料筆數不足回 null(不是 false),這樣 normalize 階段
--   會把該 factor 視為「不可評」,不汙染 score
--
-- 範圍:universe ∪ industry ∪ holdings ∪ watchlist(籌碼 4 表都不含 ETF,所以不 union etf_metadata)

drop view if exists public.v_chip_factors cascade;

create view public.v_chip_factors as
with universe_symbols as (
  select symbol from public.stock_universe
  union
  select symbol from public.industry_stocks
  union
  select symbol from public.watchlist
  union
  select symbol from public.holdings_transactions
),
-- ===================== 法人連續 3 日買超 =====================
inst_recent as (
  select
    i.symbol, i.trade_date, i.foreign_net,
    row_number() over (partition by i.symbol order by i.trade_date desc) as rn
  from public.stock_institutional i
  inner join universe_symbols u on u.symbol = i.symbol
  where i.trade_date >= current_date - interval '14 days'
),
inst_agg as (
  select
    symbol,
    count(*) filter (where rn <= 3) as inst_days_available,
    -- 三日都 > 0 才算「連續買超」
    bool_and(case when rn <= 3 then foreign_net > 0 end) filter (where rn <= 3) as inst_3d_all_buy,
    sum(case when rn <= 3 then foreign_net end) as foreign_net_3d_sum,
    max(case when rn = 1 then foreign_net end) as foreign_net_latest
  from inst_recent
  group by symbol
),
-- ===================== 融資餘額減少 =====================
margin_recent as (
  select
    m.symbol, m.trade_date, m.margin_delta, m.margin_balance,
    row_number() over (partition by m.symbol order by m.trade_date desc) as rn
  from public.stock_margin m
  inner join universe_symbols u on u.symbol = m.symbol
  where m.trade_date >= current_date - interval '14 days'
),
margin_agg as (
  select
    symbol,
    count(*) filter (where rn <= 5) as margin_days_available,
    sum(case when rn <= 5 then margin_delta end) as margin_delta_5d_sum,
    max(case when rn = 1 then margin_balance end) as margin_balance_latest
  from margin_recent
  group by symbol
),
-- ===================== 借券餘額減少 =====================
lending_recent as (
  select
    l.symbol, l.trade_date, l.daily_lending_volume,
    row_number() over (partition by l.symbol order by l.trade_date desc) as rn
  from public.v_securities_lending_daily l
  inner join universe_symbols u on u.symbol = l.symbol
  where l.trade_date >= current_date - interval '14 days'
),
lending_agg as (
  select
    symbol,
    count(*) as lending_days_available,
    max(case when rn = 1 then daily_lending_volume end) as lending_latest,
    max(case when rn = 2 then daily_lending_volume end) as lending_prev
  from lending_recent
  group by symbol
),
-- ===================== 集保外資持股比例增加 =====================
share_recent as (
  select
    s.symbol, s.report_date, s.foreign_holding_ratio,
    row_number() over (partition by s.symbol order by s.report_date desc) as rn
  from public.stock_shareholding s
  inner join universe_symbols u on u.symbol = s.symbol
  where s.report_date >= current_date - interval '60 days'
),
share_agg as (
  select
    symbol,
    count(*) as share_weeks_available,
    max(case when rn = 1 then foreign_holding_ratio end) as foreign_ratio_latest,
    max(case when rn = 2 then foreign_holding_ratio end) as foreign_ratio_prev
  from share_recent
  group by symbol
)
select
  u.symbol,
  -- =============== Factor 1:法人連續 3 日買超 ===============
  case
    when ia.inst_days_available is null or ia.inst_days_available < 3 then null::boolean
    else ia.inst_3d_all_buy
  end as chip_foreign_3d_buy,
  ia.foreign_net_latest,
  ia.foreign_net_3d_sum,
  -- =============== Factor 2:近 5 日融資餘額累計減少 ===============
  case
    when ma.margin_days_available is null or ma.margin_days_available < 3 then null::boolean
    else (ma.margin_delta_5d_sum < 0)
  end as chip_margin_drop,
  ma.margin_balance_latest,
  ma.margin_delta_5d_sum,
  -- =============== Factor 3:借券餘額減少(latest < prev)===============
  case
    when la.lending_latest is null or la.lending_prev is null then null::boolean
    else (la.lending_latest < la.lending_prev)
  end as chip_lending_drop,
  la.lending_latest,
  la.lending_prev,
  -- =============== Factor 4:外資持股比例週對週上升 ===============
  case
    when sa.foreign_ratio_latest is null or sa.foreign_ratio_prev is null then null::boolean
    else (sa.foreign_ratio_latest > sa.foreign_ratio_prev)
  end as chip_share_concentrate,
  sa.foreign_ratio_latest,
  sa.foreign_ratio_prev
from universe_symbols u
left join inst_agg ia on ia.symbol = u.symbol
left join margin_agg ma on ma.symbol = u.symbol
left join lending_agg la on la.symbol = u.symbol
left join share_agg sa on sa.symbol = u.symbol;

comment on view public.v_chip_factors is
  'M9 籌碼 4 因子:法人 3 日買超 / 融資餘額減 / 借券減 / 外資持股升。
   空資料時 factor = null(不評),不影響其他維度。
   依賴 M8 stock_institutional / stock_margin / stock_shareholding / v_securities_lending_daily。';
