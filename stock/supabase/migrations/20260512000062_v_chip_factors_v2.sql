-- M9.1: v_chip_factors v2 — 新增「法人集中度」factor
--
-- 新 factor:chip_inst_concentration
--   近 3 日法人合計 net(foreign + invest_trust + dealer)
--   / 近 3 日總成交量(price_daily.volume) > 5%
--
--   解釋:三大法人 3 日累計買賣金額 / 3 日總成交量(類比法人主導比例)。
--   > 5% 代表近期法人著墨重,籌碼集中度高 — 是看多訊號(若 net > 0)。
--   注意:這裡用 net,所以 net < 0 大量賣超的情況下,abs ratio 也可能 > 5%(代表大賣)
--         → factor 是「絕對值集中度」,代表「法人有意見」(可能多可能空)
--         + 但 v_factor_scores 解讀時用 absolute(關注度高就算過),搭配其他 chip factor 過濾方向
--
-- 重新解讀:陳設 spec「3 日法人合計 net / 3 日總量 > 5%」字面是 net(可正可負),
--   但「集中度」概念通常意指 abs 比例。spec 沒明說,我採嚴格字面:net / total > 5%(正向集中)。
--   也就是法人「淨買」佔總量 5% 以上(看多訊號)。法人淨賣的不算過關(更安全)。
--
-- 資料不足:
--   3 日 institutional rows < 3 或 3 日 price_daily volume sum is null/0 → null(不評)
--
-- 其他 4 factor 保留:
--   chip_foreign_3d_buy / chip_margin_drop / chip_lending_drop / chip_share_concentrate

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
-- ===================== 法人連續 3 日買超 + 3 日 net total =====================
inst_recent as (
  select
    i.symbol, i.trade_date, i.foreign_net, i.three_major_net,
    row_number() over (partition by i.symbol order by i.trade_date desc) as rn
  from public.stock_institutional i
  inner join universe_symbols u on u.symbol = i.symbol
  where i.trade_date >= current_date - interval '14 days'
),
inst_agg as (
  select
    symbol,
    count(*) filter (where rn <= 3) as inst_days_available,
    bool_and(case when rn <= 3 then foreign_net > 0 end) filter (where rn <= 3) as inst_3d_all_buy,
    sum(case when rn <= 3 then foreign_net end) as foreign_net_3d_sum,
    max(case when rn = 1 then foreign_net end) as foreign_net_latest,
    -- 三大法人 net 三日 sum(給 concentration factor 用)
    sum(case when rn <= 3 then three_major_net end) as three_major_net_3d_sum
  from inst_recent
  group by symbol
),
-- ===================== 近 3 日 price_daily 總成交量 =====================
price_vol_recent as (
  select
    p.symbol, p.trade_date, p.volume,
    row_number() over (partition by p.symbol order by p.trade_date desc) as rn
  from public.price_daily p
  inner join universe_symbols u on u.symbol = p.symbol
  where p.trade_date >= current_date - interval '14 days'
),
price_vol_agg as (
  select
    symbol,
    count(*) filter (where rn <= 3) as vol_days_available,
    sum(case when rn <= 3 then volume end) as volume_3d_sum
  from price_vol_recent
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
  sa.foreign_ratio_prev,
  -- =============== Factor 5 (NEW):法人 3 日 net / 總量 > 5%(集中度)===============
  -- 條件:3 日 institutional + 3 日 volume 都有資料,且 ratio > 0.05(法人淨買主導)
  case
    when ia.inst_days_available is null or ia.inst_days_available < 3 then null::boolean
    when pva.vol_days_available is null or pva.vol_days_available < 3 then null::boolean
    when ia.three_major_net_3d_sum is null or pva.volume_3d_sum is null or pva.volume_3d_sum = 0
      then null::boolean
    else (ia.three_major_net_3d_sum::numeric / pva.volume_3d_sum::numeric) > 0.05
  end as chip_inst_concentration,
  ia.three_major_net_3d_sum,
  pva.volume_3d_sum
from universe_symbols u
left join inst_agg ia on ia.symbol = u.symbol
left join margin_agg ma on ma.symbol = u.symbol
left join lending_agg la on la.symbol = u.symbol
left join share_agg sa on sa.symbol = u.symbol
left join price_vol_agg pva on pva.symbol = u.symbol;

comment on view public.v_chip_factors is
  'M9.1 籌碼 5 因子 v2:法人 3 日買超 / 融資餘額減 / 借券減 / 外資持股升 + (新) 法人 3 日 net 占成交量 > 5%。
   集中度 factor 反映「近期法人淨買主導程度」,過關 = 法人有主導意願且方向偏多。';
