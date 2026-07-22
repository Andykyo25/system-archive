-- 個股頁資料曝光:籌碼時序 + 估值分位帶(2026-07-22)
--
-- 動機:籌碼 4 表(法人/融資/借券/外資持股)各有約 3 個月資料、stock_pe_pb_daily 有 3.5 年,
--   但 UI 上完全看不到 —— 籌碼只被壓成 v_chip_factors 的布林燈號(過/不過),
--   看不到「往哪個方向走、走多久了」;估值則完全沒曝光。
--
-- 定位:純資訊呈現(走 B),不進選股/回測/因子 → 免 L36 OOS 閘。
--   估值分位是「歷史相對位置」不是買賣訊號(L38/L48 措辭紀律,UI 文案同步標註)。

-- ── 1. 籌碼時序(長格式,前端 group by series_key 畫 sparkline)──────────
-- 長格式而非寬表的理由:4 個來源日期粒度不同(前三者日更、外資持股週更),
-- 寬表會產生大量 null 且 join 成本高;長格式前端一次查完自己分組即可。
create or replace view public.v_symbol_chip_series as
select
  symbol,
  'inst_net'::text                       as series_key,
  trade_date                             as as_of,
  three_major_net::numeric               as value
from public.stock_institutional
where trade_date >= current_date - interval '120 days'
  and three_major_net is not null

union all
select
  symbol,
  'margin_balance',
  trade_date,
  margin_balance::numeric
from public.stock_margin
where trade_date >= current_date - interval '120 days'
  and margin_balance is not null

union all
select
  symbol,
  'lending_volume',
  trade_date,
  daily_lending_volume::numeric
from public.v_securities_lending_daily
where trade_date >= current_date - interval '120 days'
  and daily_lending_volume is not null

union all
select
  symbol,
  'foreign_ratio',
  report_date,
  foreign_holding_ratio::numeric
from public.stock_shareholding
where report_date >= current_date - interval '120 days'
  and foreign_holding_ratio is not null;

comment on view public.v_symbol_chip_series is
  '個股籌碼時序(近 120 天長格式):inst_net 三大法人淨買賣 / margin_balance 融資餘額 / '
  'lending_volume 借券賣出量 / foreign_ratio 外資持股比。純呈現用,不進因子。';

grant select on public.v_symbol_chip_series to service_role;


-- ── 2. 估值分位帶(近 3 年)──────────────────────────────────────────
-- p20/p50/p80 用 percentile_cont;現值百分位用「歷史有多少比例的日子比現在便宜」。
-- 只取 pe/pb > 0 的交易日:虧損期 PE 為負或 null,納入會讓分位失真。
create or replace view public.v_symbol_valuation_band as
with hist as (
  select symbol, pe, pb
  from public.stock_pe_pb_daily
  where trade_date >= current_date - interval '3 years'
),
pe_band as (
  select
    symbol,
    percentile_cont(0.20) within group (order by pe) as pe_p20,
    percentile_cont(0.50) within group (order by pe) as pe_p50,
    percentile_cont(0.80) within group (order by pe) as pe_p80,
    count(*)                                         as pe_n
  from hist where pe > 0
  group by symbol
),
pb_band as (
  select
    symbol,
    percentile_cont(0.20) within group (order by pb) as pb_p20,
    percentile_cont(0.50) within group (order by pb) as pb_p50,
    percentile_cont(0.80) within group (order by pb) as pb_p80,
    count(*)                                         as pb_n
  from hist where pb > 0
  group by symbol
),
latest as (
  select distinct on (symbol) symbol, trade_date, pe, pb, dividend_yield
  from public.stock_pe_pb_daily
  order by symbol, trade_date desc
),
pctile as (
  select
    l.symbol,
    round(100.0 * avg(case when h.pe <= l.pe then 1 else 0 end), 1) as pe_pctile
  from latest l
  join hist h on h.symbol = l.symbol
  where h.pe > 0 and l.pe > 0
  group by l.symbol
),
pctile_pb as (
  select
    l.symbol,
    round(100.0 * avg(case when h.pb <= l.pb then 1 else 0 end), 1) as pb_pctile
  from latest l
  join hist h on h.symbol = l.symbol
  where h.pb > 0 and l.pb > 0
  group by l.symbol
)
select
  l.symbol,
  l.trade_date        as as_of,
  l.pe                as pe_now,
  l.pb                as pb_now,
  l.dividend_yield,
  e.pe_p20, e.pe_p50, e.pe_p80, e.pe_n,
  b.pb_p20, b.pb_p50, b.pb_p80, b.pb_n,
  p.pe_pctile,
  q.pb_pctile
from latest l
left join pe_band  e on e.symbol = l.symbol
left join pb_band  b on b.symbol = l.symbol
left join pctile   p on p.symbol = l.symbol
left join pctile_pb q on q.symbol = l.symbol;

comment on view public.v_symbol_valuation_band is
  '個股估值分位帶(近 3 年 PE/PB 的 p20/p50/p80 + 現值所在百分位)。'
  '純歷史相對位置,不是買賣訊號 —— 便宜可能是基本面轉壞,貴可能是成長被認可。';

grant select on public.v_symbol_valuation_band to service_role;
