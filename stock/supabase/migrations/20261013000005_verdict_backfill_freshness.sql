-- 修正 20261013000002:看多補料要補「過期」不只補「缺」(2026-10-13)
--
-- 實查:3605 於 10/07 被熱股池 cap 擠出後籌碼日更停收,法人最新只到 10/07;近 14 日仍有 ≥3 筆,
-- 舊條件(只看筆數)判定不缺 → 籌碼因子用的是 10/03~10/07 的「最近 3 筆」而不是最近 3 個交易日。
-- 修正:
--   1. 每個 dataset 再比「該股最新日 < 全表最新日」= 過期 → 也要補(回看窗同前,補洞不覆寫)。
--   2. 日更類冷卻改 3 小時(原為 1 天):法人 / 融資券約 16:30~17:00 才公布,14:40 補過的股
--      在 17:40 那輪仍可再補到當日;一天最多 14:40 / 17:40 / 22:40 三次。慢變類維持 7 天。
--      → 請求紀錄主鍵改為 (symbol, dataset, requested_at),同日可多筆。
--   資料源本身沒有(例:創新板不可融資券)時,每天最多重打 3 次 × 1 call,可接受。
--
-- rollback:tasks/rollback-20261013.sql(整支函式移除);或重跑 20261013000002 的函式定義。

alter table public.verdict_backfill_requests drop constraint if exists verdict_backfill_requests_pkey;
alter table public.verdict_backfill_requests add primary key (symbol, dataset, requested_at);

create or replace function public.request_verdict_backfill()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Asia/Taipei')::date;
  d date;
  n numeric;
  typical numeric;
  auth text;
  r record;
  total integer := 0;
begin
  select max(trade_date) into d from price_daily where symbol = '0050';
  if d is null then return 0; end if;
  select count(*) into n from price_daily where trade_date = d;
  select percentile_cont(0.5) within group (order by c) into typical
  from (select count(*) c from price_daily where trade_date < d
        group by trade_date order by trade_date desc limit 20) p;
  if typical is null or n < typical * 0.8 then return 0; end if;

  perform capture_collection_candidates();

  for r in
    with latest as (
      select
        (select max(period_end) from stock_fundamentals_quarterly) as fund,
        (select max(make_date(period_year, period_month, 1)) from stock_monthly_revenue) as rev,
        (select max(trade_date) from stock_pe_pb_daily) as val,
        (select max(trade_date) from stock_institutional) as inst,
        (select max(trade_date) from stock_margin) as margin,
        (select max(trade_date) from v_securities_lending_daily) as lend,
        (select max(report_date) from stock_shareholding) as share
    ),
    v as (
      select symbol, max(trade_date) as signal_date from v_scan_verdict group by symbol
    ),
    need as (
      select v.symbol, v.signal_date, x.dataset, x.start_date
      from v
      cross join latest m
      cross join lateral (values
        ('price', (today - interval '3 years')::date, interval '7 days',
          (select count(*) from price_daily p where p.symbol = v.symbol and p.trade_date > today - 320) < 200),
        ('fundamentals', (today - interval '3 years')::date, interval '7 days',
          (select count(*) from stock_fundamentals_quarterly f where f.symbol = v.symbol and f.period_end >= today - interval '30 months') < 8
          or coalesce((select max(f.period_end) from stock_fundamentals_quarterly f where f.symbol = v.symbol), '-infinity') < m.fund),
        ('monthly_revenue', (today - interval '3 years')::date, interval '7 days',
          (select count(*) from stock_monthly_revenue mr where mr.symbol = v.symbol
             and make_date(mr.period_year, mr.period_month, 1) >= date_trunc('month', today) - interval '15 months') < 13
          or coalesce((select max(make_date(mr.period_year, mr.period_month, 1)) from stock_monthly_revenue mr where mr.symbol = v.symbol), '-infinity') < m.rev),
        ('valuation', today - 30, interval '3 hours',
          coalesce((select max(e.trade_date) from stock_pe_pb_daily e where e.symbol = v.symbol), '-infinity') < m.val),
        ('institutional', today - 30, interval '3 hours',
          (select count(*) from stock_institutional i where i.symbol = v.symbol and i.trade_date > today - 14) < 3
          or coalesce((select max(i.trade_date) from stock_institutional i where i.symbol = v.symbol), '-infinity') < m.inst),
        ('margin', today - 30, interval '3 hours',
          (select count(*) from stock_margin g where g.symbol = v.symbol and g.trade_date > today - 14) < 3
          or coalesce((select max(g.trade_date) from stock_margin g where g.symbol = v.symbol), '-infinity') < m.margin),
        ('lending', today - 30, interval '3 hours',
          (select count(distinct l.trade_date) from v_securities_lending_daily l where l.symbol = v.symbol and l.trade_date > today - 14) < 2
          or coalesce((select max(l.trade_date) from v_securities_lending_daily l where l.symbol = v.symbol), '-infinity') < m.lend),
        ('shareholding', today - 60, interval '3 hours',
          (select count(*) from stock_shareholding s where s.symbol = v.symbol and s.report_date > today - 60) < 2
          or coalesce((select max(s.report_date) from stock_shareholding s where s.symbol = v.symbol), '-infinity') < m.share)
      ) x(dataset, start_date, cooldown, missing)
      where x.missing
        and not exists (
          select 1 from verdict_backfill_requests q
          where q.symbol = v.symbol and q.dataset = x.dataset and q.requested_at > now() - x.cooldown)
    )
    select dataset, min(start_date) as start_date, max(signal_date) as signal_date,
           array_agg(symbol order by symbol) as symbols
    from need group by dataset order by dataset
  loop
    if auth is null then
      auth := read_edge_function_auth();
      if auth is null then raise exception 'worker credential unavailable'; end if;
    end if;
    perform net.http_post(
      url := 'https://trnvkwievjewhghdvniq.supabase.co/functions/v1/fetch-finmind-backfill',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || auth),
      body := jsonb_build_object(
        'dataset', r.dataset,
        'start_date', r.start_date::text,
        'end_date', today::text,
        'symbols', to_jsonb(r.symbols),
        'token_key', 'finmind_token_2'),
      timeout_milliseconds := 300000);
    insert into verdict_backfill_requests(symbol, dataset, request_date, signal_date, start_date)
    select unnest(r.symbols), r.dataset, today, r.signal_date, r.start_date
    on conflict do nothing;
    total := total + cardinality(r.symbols);
  end loop;
  return total;
end $$;

revoke all on function public.request_verdict_backfill() from public, anon, authenticated;
grant execute on function public.request_verdict_backfill() to service_role;
