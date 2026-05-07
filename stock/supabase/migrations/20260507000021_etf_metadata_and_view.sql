-- ETF 區資料層
-- etf_metadata:每檔 ETF 的中文名稱、類型、內扣費用、規模、是否主動式
-- v_etf_picks:整合 metadata + price_daily + stock_pe_pb_daily,計分

create table public.etf_metadata (
  symbol text primary key,
  name text,
  category text not null default '其他',  -- 市值型 / 高股息 / 主題 / 主動式 / 債券 / 其他
  expense_ratio numeric(8,4),                -- 內扣費用 %
  fund_size_billion numeric(10,2),           -- 規模(億 NTD)
  is_active_etf boolean not null default false,
  notes text,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.etf_metadata enable row level security;

insert into public.etf_metadata (symbol, name, category, expense_ratio, fund_size_billion, is_active_etf) values
  ('0050',   '元大台灣50',          '市值型',   0.32,  4500, false),
  ('0052',   '富邦科技',            '主題',     0.13,   100, false),
  ('0056',   '元大高股息',          '高股息',   0.41,  3500, false),
  ('006208', '富邦台50',            '市值型',   0.24,   800, false),
  ('00713',  '元大台灣高息低波',    '高股息',   0.32,   700, false),
  ('00878',  '國泰永續高股息',      '高股息',   0.28,  3500, false),
  ('00919',  '群益台灣精選高息',    '高股息',   0.30,  4500, false),
  ('00929',  '復華台灣科技優息',    '高股息',   0.34,  1500, false),
  ('00940',  '元大台灣價值高息',    '高股息',   0.30,  1500, false),
  ('00679B', '元大美債20年',        '債券',     0.15,   200, false),
  ('00981A', '第一金主動投資1000',  '主動式',   0.99,    50, true);

create view public.v_etf_picks as
with ranked as (
  select symbol, trade_date, close, is_provisional,
    row_number() over (partition by symbol order by trade_date desc) as rn
  from public.price_daily
),
today as (select symbol, trade_date, close, is_provisional from ranked where rn = 1),
prev_5d as (select symbol, close as close_5d_ago from ranked where rn = 6),
prev_20d as (select symbol, close as close_20d_ago from ranked where rn = 21),
volume_avg as (
  select symbol, avg(volume) as avg_20d_volume
  from public.price_daily
  where trade_date >= current_date - interval '30 days'
  group by symbol
),
latest_valuation as (
  select distinct on (symbol) symbol, dividend_yield, pe, pb
  from public.stock_pe_pb_daily
  order by symbol, trade_date desc
)
select
  e.symbol, e.name, e.category, e.expense_ratio, e.fund_size_billion, e.is_active_etf, e.notes,
  t.close as current_price, t.trade_date, t.is_provisional,
  case when t.close is not null and p5.close_5d_ago is not null and p5.close_5d_ago > 0
    then ((t.close - p5.close_5d_ago) / p5.close_5d_ago) * 100
  end as pct_5d,
  case when t.close is not null and p20.close_20d_ago is not null and p20.close_20d_ago > 0
    then ((t.close - p20.close_20d_ago) / p20.close_20d_ago) * 100
  end as pct_20d,
  v.dividend_yield, v.pe, v.pb,
  vol.avg_20d_volume,
  (case when e.expense_ratio is not null and e.expense_ratio < 0.5 then 1 else 0 end) +
  (case when e.fund_size_billion is not null and e.fund_size_billion > 100 then 1 else 0 end) +
  (case when v.dividend_yield is not null and v.dividend_yield > 4 then 1 else 0 end) +
  (case when t.close is not null and p5.close_5d_ago is not null and t.close > p5.close_5d_ago then 1 else 0 end) +
  (case when vol.avg_20d_volume is not null and vol.avg_20d_volume > 1000000 then 1 else 0 end)
  as score
from public.etf_metadata e
left join today t on t.symbol = e.symbol
left join prev_5d p5 on p5.symbol = e.symbol
left join prev_20d p20 on p20.symbol = e.symbol
left join volume_avg vol on vol.symbol = e.symbol
left join latest_valuation v on v.symbol = e.symbol;
