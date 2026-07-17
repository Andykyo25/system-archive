-- 全市場股名表(2026-07-17):動態熱股無中文名 gap 根治(7/03 已知 gap ①)
-- 源:TWSE t187ap03_L(公司簡稱)+ TPEX mopsfin_t187ap03_O(CompanyAbbreviation),零 quota,週更
create table public.stock_names (
  symbol text primary key,
  name text not null,
  market text not null, -- twse | tpex
  updated_at timestamptz not null default now()
);
alter table public.stock_names enable row level security;

-- v_swing_scan v2(Andy「我都玩短線居多」):
--   + ret_20d_pct > 0(20 日動能還活著;實證:8 筆勝單 ret20d_at_buy 全正,唯一 20 日轉負買入 = 深接刀敗)
--   + name fallback stock_names(動態熱股補名)
--   + 排序改 進行式優先(hot > 20 日動能)
-- 欄位名稱/順序零變動(L37,create or replace 合法)
create or replace view public.v_swing_scan as
select
  r.symbol,
  coalesce(su.name, sn.name) as name,
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
left join public.stock_names sn on sn.symbol = eq.symbol
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
  and r.ret_20d_pct > 0
  and r.latest_close > r.ma60_now
order by (ud.symbol is not null) desc, r.ret_20d_pct desc;
