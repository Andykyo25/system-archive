-- /scan 前向凍結 scan_picks + 追蹤 v_scan_track(2026-08-06)
--
-- 動機:v_breakout_scan 目前只有「事後重算」的回顧數字,而那種數字最會騙人 ——
-- 今天補完 backfill,同一組條件的 5 日超額就從 +1.58pp 翻成 -0.81pp([[L60]])。
-- paper_picks 之所以可信,是因為它「當天選完就凍結,之後不能改」,結構上不可能
-- 有前視偏誤。本表把同一個機制套到起漲掃描上。
--
-- 設計取捨:**只凍結「當時選了誰」,不回填報酬**。
--   paper_picks 需要 settle 流程(回填 exit_px);本表改成後續報酬由 v_scan_track
--   即時 join price_daily 算。好處:① 少一個會靜默壞掉的回填 cron([[L42]]/[[L46]])
--   ② 報酬永遠反映最新資料 ③ 凍結的是選股決策(唯一會被竄改的部分),
--   價格本身是客觀事實,沒有凍結的必要。
--
-- 收錄門檻 score_total >= 80(不只 passes_all):兩組都記、用 passes_all 區分,
-- 樣本累積較快,且日後可分別回答「五條件嚴格版」與「高分寬鬆版」哪個好。

create table if not exists public.scan_picks (
  scan_date       date    not null,
  symbol          text    not null,
  name            text,
  industry_category text,
  close           numeric(16,4) not null,
  score_total     integer,
  score_surge     integer,
  score_position  integer,
  score_momentum  integer,
  passes_all      boolean,
  day_pct         numeric(10,4),
  volume_lots     numeric(16,2),
  frozen_at       timestamptz not null default now(),
  primary key (scan_date, symbol)
);

alter table public.scan_picks enable row level security;

comment on table public.scan_picks is
  'Forward-frozen picks from v_breakout_scan (score_total >= 80), one row per (scan_date, symbol). Freezes WHAT WAS SELECTED at the time - the only part that can be retroactively distorted. Forward returns are computed live by v_scan_track against price_daily, so there is no backfill cron that can silently die. Started 2026-08-06; needs 6+ months before it can answer anything.';

-- ── 追蹤 view:凍結當日之後的第 1/6/11/21 個交易日收盤 ──────────────
-- entry = 訊號日的次一交易日收盤(訊號在收盤後才知,最早 T+1 才能進場)
create or replace view public.v_scan_track as
select
  p.scan_date,
  p.symbol,
  p.name,
  p.industry_category,
  p.passes_all,
  p.score_total,
  p.close                                   as signal_close,
  f.pxs[1]                                  as entry_px,
  round(100.0 * (f.pxs[6]  / nullif(f.pxs[1],0) - 1), 2) as ret_5d,
  round(100.0 * (f.pxs[11] / nullif(f.pxs[1],0) - 1), 2) as ret_10d,
  round(100.0 * (f.pxs[21] / nullif(f.pxs[1],0) - 1), 2) as ret_20d,
  round(100.0 * (b.pxs[6]  / nullif(b.pxs[1],0) - 1), 2) as bench_5d,
  round(100.0 * (b.pxs[11] / nullif(b.pxs[1],0) - 1), 2) as bench_10d,
  round(100.0 * (b.pxs[21] / nullif(b.pxs[1],0) - 1), 2) as bench_20d,
  round(100.0 * (f.pxs[6]  / nullif(f.pxs[1],0) - 1)
      - 100.0 * (b.pxs[6]  / nullif(b.pxs[1],0) - 1), 2) as excess_5d,
  round(100.0 * (f.pxs[21] / nullif(f.pxs[1],0) - 1)
      - 100.0 * (b.pxs[21] / nullif(b.pxs[1],0) - 1), 2) as excess_20d
from public.scan_picks p
left join lateral (
  select array_agg(close order by trade_date) as pxs
  from (
    select close, trade_date from public.price_daily
    where symbol = p.symbol and trade_date > p.scan_date and close > 0
    order by trade_date limit 21
  ) t
) f on true
left join lateral (
  select array_agg(close order by trade_date) as pxs
  from (
    select close, trade_date from public.market_bench_daily
    where symbol = 'TAIEX_TR' and trade_date > p.scan_date
    order by trade_date limit 21
  ) t
) b on true;

comment on view public.v_scan_track is
  'Forward performance of scan_picks vs TAIEX total-return index. Entry = next trading day close after the signal date (signal is only knowable after close). NULL returns mean the horizon has not elapsed yet, not zero.';

grant select on public.scan_picks   to service_role;
grant select on public.v_scan_track to service_role;

-- ── 每日凍結 cron ────────────────────────────────────────────────
-- 07:00 UTC = 15:00 Taipei。此時前一交易日的 twse(隔日 06:30 UTC 補)與
-- tpex(當日 14:00 UTC)都已入庫,v_breakout_scan 的 max(trade_date) 為完整交易日。
-- 純 SQL,不需要 EF。on conflict do nothing → 同日重跑冪等。
select cron.schedule(
  'freeze-scan-picks-daily',
  '0 7 * * 1-6',
  $$
  insert into public.scan_picks (
    scan_date, symbol, name, industry_category, close,
    score_total, score_surge, score_position, score_momentum,
    passes_all, day_pct, volume_lots)
  select trade_date, symbol, name, industry_category, close,
         score_total, score_surge, score_position, score_momentum,
         passes_all, day_pct, volume_lots
  from public.v_breakout_scan
  where score_total >= 80
  on conflict (scan_date, symbol) do nothing;
  $$
);
