-- B 工程(2026-07-03):Universe 改革 — 全市場雷達 + 熱股動態晉升
--
-- 痛點:固定 ~160 檔 universe 漏熱門股(實證:3236 上櫃熱股只在 watchlist,
--   7/01 Andy 盲區追高 −6.9%;系統無價位區/因子/排名資料)。
-- 架構(Andy 拍板:90 日滾動窗 + 動態池 cap 50):
--   層1 全市場價格(零 quota):fetch-daily-prices v8 改寫入全部 4 碼普通股
--   層2 熱股雷達(本 migration):每日收盤後掃 成交值/20日漲幅/60日新高 → universe_dynamic
--   層3 rank/PIT 整合(下一 migration):因子 view + score_universe_at added_at gate
--
-- 誠實 caveat:
--   * 雷達用 raw close(全市場股無 adj_factor 維護),除權息日附近 ret20/新高可能誤判
--     (進池後 rank 因子同樣受影響;cap 50 + 人眼看 /rank 過濾,可接受)
--   * 上線初期全市場歷史不足:榜B 需 ≥21 筆、榜C 需 ≥40 筆 → 前 1-2 個月只有
--     成交值榜有效,累積後全功率(gate 明確,不輸出雜訊)

-- ============ 表 ============
create table if not exists public.universe_dynamic (
  symbol text primary key,
  added_at date not null default current_date,   -- 首次晉升日(PIT 回測 gate 用)
  reason text,                                    -- 最近一次上榜原因
  last_hot_at date,                               -- 最近一次在榜日
  active boolean not null default true,           -- false = 已退場(row 永久保留,PIT 需要)
  deactivated_at date
);

comment on table public.universe_dynamic is
  '熱股動態池(cap 50):每日雷達自動晉升/退場。row 永不刪(added_at/deactivated_at 供 PIT 回測 gate)。';

-- ============ 雷達 ============
-- 回傳「本次新晉升」的 symbols(cron 用它觸發 fetch-finmind-backfill 補歷史)
create or replace function public.scan_hot_stocks()
returns text[]
language plpgsql
as $$
declare
  d date;
  new_syms text[] := '{}';
  over_cap int;
begin
  select max(trade_date) into d from public.price_daily;
  if d is null then
    return new_syms;
  end if;

  -- 榜單:全市場 4 碼普通股(排除 00 開頭 ETF)
  create temp table _hot on commit drop as
  with latest as (
    select symbol, close, volume, close * volume as turnover
    from public.price_daily
    where trade_date = d and close > 0
      and symbol ~ '^[0-9]{4}$' and symbol !~ '^00'
  ),
  hist as (
    select p.symbol,
           count(*) as n,
           max(p.close) filter (where p.trade_date < d) as hi_prev,
           avg(p.volume) filter (where p.trade_date >= d - 30) as vol20,
           (array_agg(p.close order by p.trade_date desc))[21] as close_21_back
    from public.price_daily p
    join latest l on l.symbol = p.symbol
    where p.trade_date > d - 100 and p.close > 0
    group by p.symbol
  )
  select l.symbol,
         case
           when rank() over (order by l.turnover desc) <= 30 then '成交值Top30'
           when h.n >= 21 and l.turnover >= 5e7
                and rank() over (order by case when h.n >= 21 and l.turnover >= 5e7
                      then l.close / nullif(h.close_21_back, 0) end desc nulls last) <= 30
             then '20日漲幅Top30'
           when h.n >= 40 and l.turnover >= 5e7
                and l.close >= h.hi_prev and l.volume > 2 * h.vol20
             then '60日新高帶量'
         end as reason
  from latest l
  join hist h on h.symbol = l.symbol;

  delete from _hot where reason is null;

  -- 已在榜的 active 股 → refresh last_hot_at(還熱)
  update public.universe_dynamic ud
  set last_hot_at = d, reason = h.reason
  from _hot h
  where ud.symbol = h.symbol and ud.active;

  -- 晉升:榜上、不在靜態收料池、不是 active dynamic
  with cand as (
    select h.symbol, h.reason from _hot h
    where not exists (select 1 from public.v_fetch_universe u where u.symbol = h.symbol)
      and not exists (select 1 from public.universe_dynamic ud where ud.symbol = h.symbol and ud.active)
  ),
  ins as (
    insert into public.universe_dynamic (symbol, added_at, reason, last_hot_at, active)
    select symbol, d, reason, d, true from cand
    on conflict (symbol) do update
      set active = true, reason = excluded.reason, last_hot_at = excluded.last_hot_at,
          deactivated_at = null
    returning symbol
  )
  select coalesce(array_agg(symbol), '{}') into new_syms from ins;

  -- 退場:60 日曆天沒再上榜,且非持股/watchlist
  update public.universe_dynamic ud
  set active = false, deactivated_at = d
  where ud.active and ud.last_hot_at < d - 60
    and not exists (select 1 from public.v_holdings_current c where c.symbol = ud.symbol)
    and not exists (select 1 from public.watchlist w where w.symbol = ud.symbol);

  -- cap 50:超額時依 last_hot_at 最舊退場(非持股/watchlist)
  select count(*) - 50 into over_cap from public.universe_dynamic where active;
  if over_cap > 0 then
    update public.universe_dynamic ud
    set active = false, deactivated_at = d
    where ud.symbol in (
      select symbol from public.universe_dynamic u2
      where u2.active
        and not exists (select 1 from public.v_holdings_current c where c.symbol = u2.symbol)
        and not exists (select 1 from public.watchlist w where w.symbol = u2.symbol)
      order by u2.last_hot_at asc, u2.symbol
      limit over_cap
    );
  end if;

  return new_syms;
end;
$$;

comment on function public.scan_hot_stocks is
  '每日熱股雷達:成交值Top30 ∪ 20日漲幅Top30(需≥21筆+成交值5千萬)∪ 60日新高帶量(≥40筆)
   → 晉升 universe_dynamic(cap 50,60天不熱退場)。回傳新晉 symbols 供 cron 觸發 backfill。';

-- ============ 90 日滾動清理 ============
-- 只清「從未被任何池追蹤過」的全市場股 >135 日曆天(≈90 交易日)舊資料。
-- 保留名單:v_fetch_universe(靜態池)∪ universe_dynamic 全部 row(含退場,PIT)
--   ∪ holdings_transactions ∪ day_trades(已平倉股的賣後走勢分析 v_trade_behavior 需要)
create or replace function public.cleanup_market_prices()
returns int
language sql
as $$
  with del as (
    delete from public.price_daily p
    where p.trade_date < current_date - 135
      and not exists (select 1 from public.v_fetch_universe u where u.symbol = p.symbol)
      and not exists (select 1 from public.universe_dynamic ud where ud.symbol = p.symbol)
      and not exists (select 1 from public.holdings_transactions t where t.symbol = p.symbol)
      and not exists (select 1 from public.day_trades dt where dt.symbol = p.symbol)
    returning 1
  )
  select count(*)::int from del;
$$;

comment on function public.cleanup_market_prices is
  '全市場價格 90 交易日滾動窗(135 日曆天):只清從未進過任何池的股;
   進過池/交易過的永久保留(L38 PIT 回測完整性)。';
