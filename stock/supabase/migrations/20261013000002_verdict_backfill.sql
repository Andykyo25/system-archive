-- 看多候選進榜即補料(2026-10-13)
--
-- 問題:
--   * 候選 18:05 才由 capture_collection_candidates 入池,籌碼日更 17:00~17:25 已跑完 → 最快隔天才收,
--     且日更只回看 current_date-3;籌碼因子要 ≥3 日法人 / 融資、2 日借券、2 期持股比。
--   * 非池股價格只有滾動窗內的根數,MA200 需 ≥180 根;可能缺月營收(6924 為 0 筆)。
-- 作法:request_verdict_backfill()
--   1. 最新交易日收盤資料到齊才動作(同 freeze_r2p_forward 的 80% 覆蓋門檻),避免用半套價格的名單補料。
--   2. capture_collection_candidates() → 名單立刻進 v_factor_universe / v_fetch_chip_universe。
--   3. 逐 dataset 找看多名單中缺料者,呼叫既有 fetch-finmind-backfill(token_2,與 scan_hot_stocks 同)。
--      每個 symbol × dataset 有冷卻期(日更類 1 天、慢變類 7 天):資料本來就不存在時(例:不可融資、
--      新上市)不會每小時重打。
--   排程 UTC 6:40~9:40(台北 14:40~17:40)每小時 + 14:40(台北 22:40,晚間價格更新後),各緊接現有
--   :50 的 mv_factor_scores refresh;17:50 那次在 18:15 freeze_r2p_forward 之前。
-- 負載:v_scan_verdict 有 LIMIT 3 → 每日最多 3 檔 × 8 dataset,約 ≤ 30 calls。
-- 不補 corporate_action:線上 R2p 與因子對全市場多數股都用未還原價(adj_factor=1),只替候選還原
--   會讓同一策略混用兩種價格並在盤中改名單 → 另案處理(全市場還原價對齊 R2p 回測)。
-- rollback:tasks/rollback-20261013.sql

create table if not exists public.verdict_backfill_requests(
  symbol text not null,
  dataset text not null,
  request_date date not null,
  signal_date date not null,
  start_date date not null,
  requested_at timestamptz not null default now(),
  primary key (symbol, dataset, request_date)
);
alter table public.verdict_backfill_requests enable row level security;
revoke all on public.verdict_backfill_requests from public, anon, authenticated;
grant all on public.verdict_backfill_requests to service_role;
comment on table public.verdict_backfill_requests is
  '看多候選補料請求紀錄(冷卻期判斷 + 稽核)。實際寫入結果看 fetch_log source=backfill_<dataset>。';

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
    with v as (
      select symbol, max(trade_date) as signal_date from v_scan_verdict group by symbol
    ),
    need as (
      select v.symbol, v.signal_date, x.dataset, x.start_date
      from v
      cross join lateral (values
        ('price', (today - interval '3 years')::date, 7,
          (select count(*) from price_daily p where p.symbol = v.symbol and p.trade_date > today - 320) < 200),
        ('fundamentals', (today - interval '3 years')::date, 7,
          (select count(*) from stock_fundamentals_quarterly f where f.symbol = v.symbol and f.period_end >= today - interval '30 months') < 8),
        ('monthly_revenue', (today - interval '3 years')::date, 7,
          (select count(*) from stock_monthly_revenue m where m.symbol = v.symbol
             and make_date(m.period_year, m.period_month, 1) >= date_trunc('month', today) - interval '15 months') < 13),
        ('valuation', today - 30, 1,
          not exists (select 1 from stock_pe_pb_daily e where e.symbol = v.symbol and e.trade_date > today - 10)),
        ('institutional', today - 30, 1,
          (select count(*) from stock_institutional i where i.symbol = v.symbol and i.trade_date > today - 14) < 3),
        ('margin', today - 30, 1,
          (select count(*) from stock_margin m where m.symbol = v.symbol and m.trade_date > today - 14) < 3),
        ('lending', today - 30, 1,
          (select count(distinct l.trade_date) from v_securities_lending_daily l where l.symbol = v.symbol and l.trade_date > today - 14) < 2),
        ('shareholding', today - 60, 1,
          (select count(*) from stock_shareholding s where s.symbol = v.symbol and s.report_date > today - 60) < 2)
      ) x(dataset, start_date, cooldown_days, missing)
      where x.missing
        and not exists (
          select 1 from verdict_backfill_requests q
          where q.symbol = v.symbol and q.dataset = x.dataset and q.request_date > today - x.cooldown_days)
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
comment on function public.request_verdict_backfill is
  '看多名單進榜即補料:收盤資料到齊後收進候選,並對缺料的 dataset 呼叫 fetch-finmind-backfill。回傳本次請求的 symbol×dataset 數。';

select cron.schedule('request-verdict-backfill', '40 6,7,8,9,14 * * 1-5',
  $job$select public.request_verdict_backfill()$job$);
