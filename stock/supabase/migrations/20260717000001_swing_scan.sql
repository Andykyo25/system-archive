-- 波段掃描(2026-07-17,Andy「排行對短線效益低」拍板)
-- 定位:候選產生器非買訊。條件 = Andy 贏單型態系統化:
--   60 日強勢(ret_60d > 20)+ 趨勢未破(close > MA60)+ 回檔至支撐(entry_zone = pullback)
-- 不動排名/因子/權重(L36 範圍外,呈現層);paper-track 用 snapshot 前向驗證。
create view public.v_swing_scan as
select
  r.symbol,
  su.name,
  (ud.symbol is not null) as is_hot,
  r.latest_close,
  r.expected_rank,
  round(r.mom_score_pct::numeric, 0) as mom_score_pct,
  round(r.ret_60d_pct::numeric, 1) as ret_60d_pct,
  round(r.ret_20d_pct::numeric, 1) as ret_20d_pct,
  round(eq.dev_ma20_pct::numeric, 1) as dev_ma20_pct,
  round(eq.off_high_pct::numeric, 1) as off_high_pct,
  round(eq.vol_ratio_5_20::numeric, 2) as vol_ratio_5_20,
  round(eq.rsi14::numeric, 0) as rsi14,
  round((a.atr14 / nullif(r.latest_close, 0) * 100)::numeric, 1) as atr_pct,
  round(eq.patience_ma20::numeric, 1) as patience_ma20
from public.v_entry_quality eq
join public.v_stock_rank r on r.symbol = eq.symbol
left join public.stock_universe su on su.symbol = eq.symbol
left join (
  select symbol from public.universe_dynamic where deactivated_at is null
) ud on ud.symbol = eq.symbol
left join lateral (
  select avg(greatest(b.high - b.low, abs(b.high - b.prev_close), abs(b.low - b.prev_close))) as atr14
  from (
    select high, low, lead(close) over (order by trade_date desc) as prev_close
    from public.price_daily
    where symbol = r.symbol and close > 0
    order by trade_date desc limit 15
  ) b
  where b.prev_close is not null and b.high > 0 and b.low > 0
) a on true
where eq.entry_zone = 'pullback'
  and r.ret_60d_pct > 20
  and r.latest_close > r.ma60_now
order by (ud.symbol is not null) desc, r.ret_60d_pct desc;

-- 前向驗證 snapshot(每交易日收盤後存當日掃描結果,累積 20-30 筆後算 fwd 報酬驗 edge)
create table public.swing_scan_snapshot (
  scan_date date not null,
  symbol text not null,
  close numeric,
  ret_60d_pct numeric,
  dev_ma20_pct numeric,
  is_hot boolean,
  expected_rank int,
  created_at timestamptz not null default now(),
  primary key (scan_date, symbol)
);
alter table public.swing_scan_snapshot enable row level security;

-- 平日 21:00 Taipei(13:00 UTC)snapshot;mv 最後一班 17:50 Taipei 已 refresh
select cron.schedule(
  'swing-scan-snapshot',
  '0 13 * * 1-5',
  $$ insert into public.swing_scan_snapshot (scan_date, symbol, close, ret_60d_pct, dev_ma20_pct, is_hot, expected_rank)
     select (now() at time zone 'Asia/Taipei')::date, symbol, latest_close, ret_60d_pct, dev_ma20_pct, is_hot, expected_rank
     from public.v_swing_scan
     on conflict do nothing; $$
);
