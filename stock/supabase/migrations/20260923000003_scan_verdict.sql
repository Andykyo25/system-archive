-- 起漲掃描「系統給結論」(2026-09-23,Andy:只列中高信心看多,介面不要人工判讀)
--
-- 1) scan_pattern_features / scan_pattern:挑選當下可知的型態(還原價,PIT)
--      A = 漲停收(day_pct ≥ 9.5)且距 60 日最高收盤 < −15%
--      B = 漲停收 或 月線乖離 ≥ 15%(非 A)
--      C = 其他
--    定義與 2026-09-23 事前登記 H-A / H-B 相同,之後不得改參數(tasks/todo.md)。
-- 2) mv_pick_scorecard 加 day_pct / gap20 / off_hi60 / pattern(僅 scan 列),其餘欄位不變。
--    以 pg_get_viewdef 包一層,不重打原定義([[L69]])。
-- 3) v_scan_pattern_stats:最近 60 個掃描日內、已到期 T+10 的同型態統計 → 信心。
--    上漲比例 ≥ 65% 且 n ≥ 60 = 高;≥ 55% 且 n ≥ 30 = 中高;其餘不上榜。
--    型態失效時比例下降會自動下榜,不需人工調參。
-- 4) v_scan_verdict:今日候選(v_breakout_scan score ≥ 80,與 scan_picks 凍結條件相同)× 型態統計,只輸出達門檻者。
-- rollback:drop view v_scan_verdict, v_scan_pattern_stats;
--   以 20260923000002 重建 mv_pick_scorecard(cron 以名稱 refresh,不受影響);drop function scan_pattern, scan_pattern_features。

create or replace function public.scan_pattern_features(p_symbol text, p_date date)
returns table (gap20 numeric, off_hi60 numeric)
language sql stable as $$
  with w as (
    select close * coalesce(adj_factor, 1) as c,
      row_number() over (order by trade_date desc) as rn
    from public.price_daily
    where symbol = p_symbol and trade_date <= p_date and close > 0
    order by trade_date desc
    limit 60
  )
  select round(100 * ((select c from w where rn = 1) / avg(c) filter (where rn <= 20) - 1), 2),
         round(100 * ((select c from w where rn = 1) / max(c) - 1), 2)
  from w
$$;

create or replace function public.scan_pattern(p_day_pct numeric, p_gap20 numeric, p_off_hi60 numeric)
returns text
language sql immutable as $$
  select case
    when p_day_pct >= 9.5 and p_off_hi60 < -15 then 'A'
    when p_day_pct >= 9.5 or p_gap20 >= 15 then 'B'
    else 'C'
  end
$$;

do $$
declare
  def text := pg_get_viewdef('public.mv_pick_scorecard'::regclass, true);
begin
  execute 'create materialized view public.mv_pick_scorecard_new as
    select s.*, sp.day_pct, f.gap20, f.off_hi60,
      case when s.system = ''scan'' then public.scan_pattern(sp.day_pct, f.gap20, f.off_hi60) end as pattern
    from (' || rtrim(def, '; ') || ') s
    left join public.scan_picks sp on s.system = ''scan'' and sp.scan_date = s.pick_date and sp.symbol = s.symbol
    left join lateral public.scan_pattern_features(s.symbol, s.pick_date) f on s.system = ''scan''';
end $$;

drop materialized view public.mv_pick_scorecard;
alter materialized view public.mv_pick_scorecard_new rename to mv_pick_scorecard;
create unique index mv_pick_scorecard_pk on public.mv_pick_scorecard (pick_id);
create index mv_pick_scorecard_sys on public.mv_pick_scorecard (system, pick_date desc);
comment on materialized view public.mv_pick_scorecard is
  '選股成績單:scan/swing/rank/mine 四來源統一逐筆前向報酬 + 判定(win/lag/up/loss/pending);scan 列另帶型態 A/B/C。cron refresh-mv-pick-scorecard 平日 15:30/22:30 Taipei。';

create or replace view public.v_scan_pattern_stats as
with recent as (
  select min(d) as since from (
    select distinct pick_date as d from public.mv_pick_scorecard
    where system = 'scan' order by d desc limit 60) x
), s as (
  select m.pattern,
    count(*) filter (where m.ret_10 is not null) as n10,
    round(100.0 * avg((m.ret_10 > 0)::int) filter (where m.ret_10 is not null), 1) as up10_pct,
    round(100.0 * avg((m.exc_10 > 0)::int) filter (where m.exc_10 is not null), 1) as beat10_pct,
    round(percentile_cont(0.5) within group (order by m.ret_10)::numeric, 2) as med_ret10,
    count(distinct m.pick_date) filter (where m.ret_10 is not null) as days10
  from public.mv_pick_scorecard m, recent r
  where m.system = 'scan' and m.pattern is not null and m.pick_date >= r.since
  group by m.pattern
)
select s.*,
  case
    when s.up10_pct >= 65 and s.n10 >= 60 then '高'
    when s.up10_pct >= 55 and s.n10 >= 30 then '中高'
  end as confidence
from s;

comment on view public.v_scan_pattern_stats is
  '起漲掃描型態 A/B/C 在最近 60 個掃描日的 T+10 前向統計;confidence 非空才上榜(高:≥65% 且 n≥60;中高:≥55% 且 n≥30)。';

create or replace view public.v_scan_verdict as
select b.*, f.gap20, f.off_hi60, x.pattern,
  st.confidence, st.up10_pct, st.beat10_pct, st.med_ret10, st.n10
from public.v_breakout_scan b
cross join lateral public.scan_pattern_features(b.symbol, b.trade_date) f
cross join lateral (select public.scan_pattern(b.day_pct, f.gap20, f.off_hi60) as pattern) x
join public.v_scan_pattern_stats st on st.pattern = x.pattern
where b.score_total >= 80 and st.confidence is not null;

comment on view public.v_scan_verdict is
  '今日起漲候選中,型態歷史 T+10 上漲比例達門檻者(中高信心以上看多)。';
