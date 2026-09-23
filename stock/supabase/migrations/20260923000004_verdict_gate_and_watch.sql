-- 上榜後風險閘門 + 盤中監控(2026-09-23,Andy:漢磊上榜但套牢重、要 5 分鐘盯一次並阻止進場)
--
-- 證據(tasks/todo.md 2026-09-23 續3):上方套牢量 >30% 的候選,同日配對 T+10 超額 1/18 天較好、
--   前後兩段皆負;A 組 ≤30% 上漲 72%(n=47)vs >30% 33%(n=15)。進場日追價 / 長上影不傷 → 不做閘門。
--
-- 1) scan_supply_share:過去 120 個交易日中,收盤落在 (價格, 價格×1.2] 的成交量佔比(上方套牢量)
-- 2) scan_pattern 4 參數版:A = 漲停 + 距 60 日高 < −15% + 套牢 ≤ 30%;D = 同上但套牢 > 30%(不上榜)
--    mv / 統計 / 今日看多改用 4 參數版;3 參數版保留(事前登記 H-A/H-B 的原始定義 = A ∪ D)。
-- 3) verdict_watch:每日凍結上榜名單與價位(與前端 planDefaults antiChase:false 同算法)
-- 4) v_verdict_live:名單 × 今日最新盤中報價 → ok / block(跌破停損、以現價重算套牢 > 30%)/ wait(尚無報價)
-- 5) verdict_watch_tick:盤中每 5 分鐘更新狀態,轉 block / 恢復時經 pg_net 推 Telegram(vault token,無需 EF)
-- rollback:unschedule 兩支 cron;drop function verdict_watch_tick, freeze_verdict_watch, verdict_plan_levels;
--   drop view v_verdict_live, v_verdict_watch_symbols; drop table verdict_watch;
--   以 20260923000003 的定義重建 mv / v_scan_pattern_stats / v_scan_verdict(3 參數 scan_pattern)。

create or replace function public.scan_supply_share(p_symbol text, p_date date, p_price numeric)
returns numeric
language sql stable as $$
  select round(
    sum(volume) filter (where close > p_price and close <= p_price * 1.2)::numeric
      / nullif(sum(volume), 0), 3)
  from (
    select close, volume from public.price_daily
    where symbol = p_symbol and trade_date <= p_date
    order by trade_date desc
    limit 120
  ) d
$$;

create or replace function public.scan_pattern(p_day_pct numeric, p_gap20 numeric, p_off_hi60 numeric, p_supply numeric)
returns text
language sql immutable as $$
  select case
    when p_day_pct >= 9.5 and p_off_hi60 < -15 then
      case when p_supply <= 0.30 then 'A' else 'D' end
    when p_day_pct >= 9.5 or p_gap20 >= 15 then 'B'
    else 'C'
  end
$$;

-- ---- mv:加 supply_share 欄、型態改 4 參數版([[L69]] 定點替換) ----
drop view public.v_scan_verdict;
drop view public.v_scan_pattern_stats;

do $$
declare
  def text := pg_get_viewdef('public.mv_pick_scorecard'::regclass, true);
  old_call text := 'scan_pattern(sp.day_pct, f.gap20, f.off_hi60)';
  new_call text := 'scan_pattern(sp.day_pct, f.gap20, f.off_hi60, scan_supply_share(s.symbol, s.pick_date, sp.close))';
  old_col text := E'    f.off_hi60,\n';
  new_col text := E'    f.off_hi60,\n    CASE WHEN s.system = ''scan''::text THEN scan_supply_share(s.symbol, s.pick_date, sp.close) END AS supply_share,\n';
  newdef text;
begin
  if (length(def) - length(replace(def, old_call, ''))) / length(old_call) <> 1
     or (length(def) - length(replace(def, old_col, ''))) / length(old_col) <> 1 then
    raise exception 'mv_pick_scorecard: anchor not unique, abort';
  end if;
  newdef := replace(replace(def, old_call, new_call), old_col, new_col);
  drop materialized view public.mv_pick_scorecard;
  execute 'create materialized view public.mv_pick_scorecard as ' || rtrim(newdef, '; ');
end $$;

create unique index mv_pick_scorecard_pk on public.mv_pick_scorecard (pick_id);
create index mv_pick_scorecard_sys on public.mv_pick_scorecard (system, pick_date desc);
comment on materialized view public.mv_pick_scorecard is
  '選股成績單:scan/swing/rank/mine 四來源統一逐筆前向報酬 + 判定;scan 列另帶型態 A/B/C/D 與上方套牢量。cron refresh-mv-pick-scorecard 平日 15:30/22:30 Taipei。';

create view public.v_scan_pattern_stats as
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
  '起漲掃描型態 A/B/C/D 在最近 60 個掃描日的 T+10 前向統計;confidence 非空才上榜(高:≥65% 且 n≥60;中高:≥55% 且 n≥30)。';

create view public.v_scan_verdict as
select b.*, f.gap20, f.off_hi60, x.pattern,
  st.confidence, st.up10_pct, st.beat10_pct, st.med_ret10, st.n10, x.supply_share
from public.v_breakout_scan b
cross join lateral public.scan_pattern_features(b.symbol, b.trade_date) f
cross join lateral (
  select public.scan_supply_share(b.symbol, b.trade_date, b.close) as supply_share
) y
cross join lateral (
  select y.supply_share, public.scan_pattern(b.day_pct, f.gap20, f.off_hi60, y.supply_share) as pattern
) x
join public.v_scan_pattern_stats st on st.pattern = x.pattern
where b.score_total >= 80 and st.confidence is not null;
comment on view public.v_scan_verdict is
  '今日起漲候選中,型態(含上方套牢量閘門)歷史 T+10 上漲比例達門檻者(中高信心以上看多)。';

-- ---- 價位:與 lib/plan-defaults.ts antiChase:false 同算法(改一邊要改另一邊) ----
create or replace function public.verdict_plan_levels(p_close numeric, p_atr14 numeric, p_ma20 numeric, p_mult numeric)
returns table (entry_min numeric, entry_max numeric, stop_price numeric)
language plpgsql immutable as $$
declare
  emin numeric := round(p_close * 0.97, 2);
  emax numeric := round(p_close * 1.03, 2);
  atr_stop numeric := case when p_atr14 is not null and p_mult is not null then p_close - p_mult * p_atr14 end;
  stop numeric;
begin
  stop := greatest(case when atr_stop > 0 then atr_stop end, case when p_ma20 > 0 then p_ma20 end);
  if stop is null then stop := emin * 0.92; end if;
  stop := least(stop, round(emin * 0.99, 2));
  stop := round(stop, 2);
  if stop >= emin then stop := round(emin - 0.01, 2); end if;
  return query select emin, emax, case when stop > 0 then stop end;
end $$;

create table if not exists public.verdict_watch (
  watch_date     date not null,
  symbol         text not null,
  name           text,
  signal_close   numeric not null,
  entry_min      numeric,
  entry_max      numeric,
  stop_price     numeric,
  supply_share   numeric,
  pattern        text,
  confidence     text,
  up10_pct       numeric,
  n10            int,
  frozen_at      timestamptz not null default now(),
  live_state     text,
  live_reason    text,
  live_price     numeric,
  live_at        timestamptz,
  notified_state text,
  primary key (watch_date, symbol)
);
alter table public.verdict_watch enable row level security;
comment on table public.verdict_watch is
  '今日看多名單凍結(每日 mv 刷新後),盤中 verdict_watch_tick 每 5 分鐘寫入 live_* 與 Telegram 推播狀態。';

create or replace function public.freeze_verdict_watch() returns int
language plpgsql as $$
declare
  d date;
  mult numeric := (select value from public.app_settings where key = 'atr_stop_multiple');
  n int;
begin
  select max(trade_date) into d from public.v_breakout_scan;
  if d is null then return 0; end if;
  drop table if exists _v;
  create temp table _v on commit drop as select * from public.v_scan_verdict;
  delete from public.verdict_watch w where w.watch_date = d
    and not exists (select 1 from _v where _v.symbol = w.symbol);
  insert into public.verdict_watch as w (watch_date, symbol, name, signal_close, entry_min, entry_max, stop_price,
    supply_share, pattern, confidence, up10_pct, n10)
  select d, v.symbol, v.name, v.close, l.entry_min, l.entry_max, l.stop_price,
    v.supply_share, v.pattern, v.confidence, v.up10_pct, v.n10
  from _v v cross join lateral public.verdict_plan_levels(v.close, v.atr14, v.ma20, mult) l
  on conflict (watch_date, symbol) do update set
    name = excluded.name, signal_close = excluded.signal_close, entry_min = excluded.entry_min,
    entry_max = excluded.entry_max, stop_price = excluded.stop_price, supply_share = excluded.supply_share,
    pattern = excluded.pattern, confidence = excluded.confidence, up10_pct = excluded.up10_pct,
    n10 = excluded.n10, frozen_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- intraday EF 收料用(輕量,不經 v_scan_verdict)
create or replace view public.v_verdict_watch_symbols as
select symbol from public.verdict_watch
where watch_date = (select max(watch_date) from public.verdict_watch);

create or replace view public.v_verdict_live as
with w as (
  select * from public.verdict_watch
  where watch_date = (select max(watch_date) from public.verdict_watch)
), q as (
  select distinct on (c.symbol) c.symbol, c.price, c.quoted_at
  from public.price_intraday_cache c join w on w.symbol = c.symbol
  where (c.quoted_at at time zone 'Asia/Taipei')::date = (now() at time zone 'Asia/Taipei')::date
    and c.price > 0
  order by c.symbol, c.quoted_at desc
), s as (
  select w.*, q.price as price_now, q.quoted_at,
    case when q.price is not null then public.scan_supply_share(w.symbol, w.watch_date, q.price) end as supply_now
  from w left join q on q.symbol = w.symbol
)
select s.watch_date, s.symbol, s.name, s.signal_close, s.entry_min, s.entry_max, s.stop_price,
  s.supply_share, s.pattern, s.confidence, s.up10_pct, s.n10,
  s.price_now, s.quoted_at, s.supply_now,
  case
    when s.price_now is null then 'wait'
    when s.price_now <= s.stop_price then 'block'
    when s.supply_now > 0.30 then 'block'
    else 'ok'
  end as state,
  case
    when s.price_now is null then '尚無今日報價'
    when s.price_now <= s.stop_price then '跌破停損 ' || s.stop_price
    when s.supply_now > 0.30 then '現價上方套牢 ' || round(s.supply_now * 100) || '%'
  end as reason,
  s.notified_state
from s;
comment on view public.v_verdict_live is
  '今日看多名單 × 今日最新盤中報價:ok 可進場 / block 停止(跌破停損或現價上方套牢 >30%)/ wait 尚無報價。';

create or replace function public.verdict_watch_tick() returns int
language plpgsql as $$
declare
  r record;
  token text := public.read_telegram_bot_token();
  chat text := public.read_telegram_chat_id();
  msg text;
  sent int := 0;
begin
  for r in select * from public.v_verdict_live loop
    update public.verdict_watch set live_state = r.state, live_reason = r.reason,
      live_price = r.price_now, live_at = now()
    where watch_date = r.watch_date and symbol = r.symbol;

    if r.state = 'wait' then continue; end if;
    -- 只推「轉為停止」與「由停止恢復」;第一次 ok 不推,避免雜訊
    if r.state = 'block' and r.notified_state is distinct from 'block' then
      msg := '🔴 停止進場 ' || r.symbol || ' ' || coalesce(r.name, '') || E'\n'
        || '現價 ' || r.price_now || ' · ' || r.reason;
    elsif r.state = 'ok' and r.notified_state = 'block' then
      msg := '🟢 恢復可進場 ' || r.symbol || ' ' || coalesce(r.name, '') || E'\n'
        || '現價 ' || r.price_now || ' · 買入 ' || r.entry_min || '–' || r.entry_max || ' · 停損 ' || r.stop_price;
    else
      if r.state = 'ok' and r.notified_state is null then
        update public.verdict_watch set notified_state = 'ok'
        where watch_date = r.watch_date and symbol = r.symbol;
      end if;
      continue;
    end if;

    if token is not null and chat is not null then
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || token || '/sendMessage',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('chat_id', chat, 'text', msg)
      );
      sent := sent + 1;
    end if;
    update public.verdict_watch set notified_state = r.state
    where watch_date = r.watch_date and symbol = r.symbol;
  end loop;
  return sent;
end $$;

-- 名單凍結:mv 刷新(07:30 / 14:30 UTC)之後
select cron.schedule('freeze-verdict-watch', '45 7,14 * * 1-5', 'select public.freeze_verdict_watch()');
-- 盤中每 5 分鐘(09:00–13:55 Taipei)
select cron.schedule('verdict-watch-tick', '*/5 1-5 * * 1-5', 'select public.verdict_watch_tick()');
