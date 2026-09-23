-- 選股成績單(2026-09-23):系統挑的股票後來「真的漲」還是「判斷錯誤跌了」
--
-- 一列 = 一次挑選。四個來源統一成同一個形狀,給 /track 讀:
--   scan  = 起漲掃描 scan_picks(v_scan_track_v2,還原價,隔日收盤進場,同日全市場等權基準)
--   swing = 回檔波段 swing_scan_snapshot(v_swing_track,隔日收盤進場,同上基準;未還原價)
--   rank  = 多因子排名 paper_picks(凍結 top10,20 交易日結算,基準 = 同批 0050)
--   mine  = 自己的買進 holdings_transactions BUY(實際成交價,基準 = 買進日收盤 ≥20 元全市場等權)
--
-- 為什麼是物化:v_scan_track_v2 單次 7.9 秒,PostgREST statement_timeout 8 秒,
--   頁面直查會隨樣本增加而逾時。refreshed_at 顯示在頁面上,cron 死掉看得到([[L65]])。
-- 判定(Andy 2026-09-23 選定「絕對漲跌為主,另列贏輸大盤」):
--   取已到期的最長天期(20 > 10 > 5)的報酬 → win 漲且贏大盤 / lag 漲但輸大盤 /
--   up 漲(無基準)/ loss 跌或持平 / pending 未到期。
-- 凍結晚於進場日的 scan 樣本(late_snapshot)不列入,避免前視。
-- rollback:drop materialized view public.mv_pick_scorecard; select cron.unschedule('refresh-mv-pick-scorecard');

create materialized view public.mv_pick_scorecard as
with scan as (
  select 'scan'::text as system,
    'scan:' || t.scan_date || ':' || t.symbol as pick_id,
    t.scan_date as pick_date, t.symbol, p.name,
    p.score_total::numeric as score, null::int as pick_rank,
    case when p.passes_all then '五條件全過' end as tag,
    p.close as entry_px,
    max(t.return_pct) filter (where t.horizon = 5  and t.observation_status = 'settled') as ret_5,
    max(t.return_pct) filter (where t.horizon = 10 and t.observation_status = 'settled') as ret_10,
    max(t.return_pct) filter (where t.horizon = 20 and t.observation_status = 'settled') as ret_20,
    max(t.excess_pct) filter (where t.horizon = 5  and t.observation_status = 'settled') as exc_5,
    max(t.excess_pct) filter (where t.horizon = 10 and t.observation_status = 'settled') as exc_10,
    max(t.excess_pct) filter (where t.horizon = 20 and t.observation_status = 'settled') as exc_20
  from public.v_scan_track_v2 t
  join public.scan_picks p on p.scan_date = t.scan_date and p.symbol = t.symbol
  group by t.scan_date, t.symbol, p.name, p.score_total, p.passes_all, p.close
  having not bool_or(t.observation_status = 'late_snapshot')
), swing as (
  select 'swing'::text,
    'swing:' || s.scan_date || ':' || s.symbol,
    s.scan_date, s.symbol, n.name,
    null::numeric, s.expected_rank,
    case when s.is_hot then '熱股' end,
    s.entry_px,
    s.ret_5d, null::numeric, s.ret_20d,
    s.excess_5d, null::numeric, s.excess_20d
  from public.v_swing_track s
  left join public.stock_names n on n.symbol = s.symbol
), rank as (
  select 'rank'::text,
    'rank:' || p.id,
    p.cohort_date, p.symbol, coalesce(n.name, e.name),
    round(p.weighted_score, 1), p.rank,
    case when p.symbol ~ '^00' then 'ETF(排名污染)' end,
    p.entry_px,
    null::numeric, null::numeric,
    case when p.status = 'settled' then round(100 * (p.exit_px / nullif(p.entry_px, 0) - 1), 2) end,
    null::numeric, null::numeric,
    case when p.status = 'settled' and b.status = 'settled' then
      round(100 * (p.exit_px / nullif(p.entry_px, 0) - b.exit_px / nullif(b.entry_px, 0)), 2) end
  from public.paper_picks p
  left join public.paper_picks b on b.cohort_date = p.cohort_date and b.is_benchmark
  left join public.stock_names n on n.symbol = p.symbol
  left join public.etf_metadata e on e.symbol = p.symbol
  where not p.is_benchmark
), days as (
  select trade_date, row_number() over (order by trade_date) as dn
  from (select distinct trade_date from public.price_daily
        where trade_date >= (select min(txn_date) from public.holdings_transactions where txn_type = 'BUY')) d
), buys as (
  select t.id, t.symbol, t.txn_date, t.price, t.signal_source, t.signal_score, t.signal_rank,
    d0.trade_date as d0, h.h, dx.trade_date as dx
  from public.holdings_transactions t
  join lateral (select trade_date, dn from days where trade_date <= t.txn_date order by trade_date desc limit 1) d0 on true
  cross join (values (5), (10), (20)) h(h)
  left join days dx on dx.dn = d0.dn + h.h
  where t.txn_type = 'BUY' and t.price > 0
), bench as (
  select a.d0, a.dx,
    round(100 * avg((px.close * coalesce(px.adj_factor, 1)) / (p0.close * coalesce(p0.adj_factor, 1)) - 1), 2) as ret
  from (select distinct d0, dx from buys where dx is not null) a
  join public.price_daily p0 on p0.trade_date = a.d0 and p0.close >= 20
  join public.price_daily px on px.symbol = p0.symbol and px.trade_date = a.dx and px.close > 0
  group by a.d0, a.dx
), mine_h as (
  select b.id, b.h,
    round(100 * ((px.close * coalesce(px.adj_factor, 1)) / coalesce(p0.adj_factor, 1) / b.price - 1), 2) as ret,
    bm.ret as bench
  from buys b
  left join public.price_daily p0 on p0.symbol = b.symbol and p0.trade_date = b.d0
  left join public.price_daily px on px.symbol = b.symbol and px.trade_date = b.dx
  left join bench bm on bm.d0 = b.d0 and bm.dx = b.dx
), mine as (
  select 'mine'::text,
    'mine:' || t.id,
    t.txn_date, t.symbol, coalesce(n.name, e.name),
    t.signal_score, t.signal_rank,
    case t.signal_source
      when 'scan' then '起漲掃描' when 'rank' then '多因子排名' when 'swing' then '回檔波段'
      when 'holdings_advice' then '持股建議' when 'news' then '新聞'
      when 'discretionary' then '自己判斷' else '未標來源' end,
    t.price,
    max(m.ret) filter (where m.h = 5), max(m.ret) filter (where m.h = 10), max(m.ret) filter (where m.h = 20),
    max(m.ret - m.bench) filter (where m.h = 5), max(m.ret - m.bench) filter (where m.h = 10),
    max(m.ret - m.bench) filter (where m.h = 20)
  from public.holdings_transactions t
  join mine_h m on m.id = t.id
  left join public.stock_names n on n.symbol = t.symbol
  left join public.etf_metadata e on e.symbol = t.symbol
  group by t.id, t.txn_date, t.symbol, n.name, e.name, t.signal_score, t.signal_rank, t.signal_source, t.price
), allp as (
  select * from scan union all select * from swing union all select * from rank union all select * from mine
), v as (
  select a.*,
    case when a.ret_20 is not null then 20 when a.ret_10 is not null then 10 when a.ret_5 is not null then 5 end as verdict_h,
    coalesce(a.ret_20, a.ret_10, a.ret_5) as verdict_ret,
    case when a.ret_20 is not null then a.exc_20 when a.ret_10 is not null then a.exc_10 else a.exc_5 end as verdict_exc
  from allp a
)
select v.*,
  case
    when v.verdict_ret is null then 'pending'
    when v.verdict_ret <= 0 then 'loss'
    when v.verdict_exc is null then 'up'
    when v.verdict_exc > 0 then 'win'
    else 'lag'
  end as verdict,
  now() as refreshed_at
from v;

create unique index mv_pick_scorecard_pk on public.mv_pick_scorecard (pick_id);
create index mv_pick_scorecard_sys on public.mv_pick_scorecard (system, pick_date desc);

comment on materialized view public.mv_pick_scorecard is
  '選股成績單:scan/swing/rank/mine 四來源統一逐筆前向報酬 + 判定(win/lag/up/loss/pending)。cron refresh-mv-pick-scorecard 平日 15:30/22:30 Taipei。';

select cron.schedule('refresh-mv-pick-scorecard', '30 7,14 * * 1-5',
  'refresh materialized view concurrently public.mv_pick_scorecard');
