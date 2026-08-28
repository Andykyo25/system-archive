-- 孤兒資料處置 + universe 年齡可見化(2026-08-28)
--
-- 四項全部照 CLAUDE.md §3「看到無關 dead code → 講出來,不要刪」:
-- 沒有 drop 任何表,處置方式是「補上讀取端」或「寫下為什麼還在收」。

-- ── 1. stock_universe:宣告為凍結種子(不加刷新 cron)────────────────────
--
-- 現況:148 檔,selected_at 全部 2026-05-12,已 107 天沒動。
-- 決定:**刻意不刷新**,理由三條:
--   (a) 新名字已有兩條動態入口 —— industry_stocks(月更 cron)與 universe_dynamic
--       (每日熱股晉升,上限 50)。再加第三條刷新等於跟 industry_stocks 重複。
--   (b) 每多一個 cron 就多一個會安靜死掉的東西。reselect_industry_stocks 2026-08-01
--       就是這樣失敗到 08-06 才被人工發現([[L61]]/[[L65]])。
--   (c) **會動的收料母體正是讓量測失效的東西**([[L60]])。穩定種子 + 獨立追蹤的動態池,
--       比一個持續漂移的大池子更容易歸因「覆蓋率變了是誰造成的」。
-- 但「凍結」與「忘記了」在監控上長得一模一樣 → 用 v_universe_health 讓年齡看得見。

comment on table public.stock_universe is
  '選股母池的**凍結種子**(2026-05-12 依當時市值 + 20 日均量選出,刻意不刷新)。'
  '新標的靠 industry_stocks(月更)與 universe_dynamic(日更熱股)進場,不靠這張表。'
  '⚠ 它沒有 as-of 欄位,拿去跑歷史回測會產生存活者偏差([[L38]])。年齡見 v_universe_health。';

create or replace view public.v_universe_health as
select 'stock_universe'   as source, count(*) as n,
       max(selected_at)::date as last_refreshed,
       (current_date - max(selected_at)::date) as age_days,
       'frozen seed (intentional)' as policy
from public.stock_universe
union all
select 'industry_stocks', count(*), max(selected_at)::date,
       (current_date - max(selected_at)::date), 'monthly cron'
from public.industry_stocks
union all
select 'universe_dynamic (active)', count(*) filter (where active), max(last_hot_at),
       (current_date - max(last_hot_at)), 'daily promotion'
from public.universe_dynamic;

comment on view public.v_universe_health is
  '三個 universe 來源的規模與年齡。stock_universe 年齡大是**設計**不是壞掉;'
  'industry_stocks 或 universe_dynamic 年齡異常才是問題。';

-- ── 2. swing_scan_snapshot:補上讀取端 ────────────────────────────────
--
-- 現況:每平日 13:00 寫一筆,累積 110 列 / 30 個 scan_date,但**零下游**——
-- 全 repo 只有 app/swing/page.tsx 的一行註解提到它,而且表結構沒有後續報酬欄位。
-- 凍結而不量測 = 在等一個永遠不會被問的問題。
-- 決定:**補 v_swing_track**(照 v_scan_track 同一套錨點與 benchmark 口徑),
-- 而不是停收。110 筆已經在那裡了,不量白不量;而且 cleanup_market_prices 每天在跑,
-- 再不接上價格可能會被清掉,樣本回不來。

create or replace view public.v_swing_track as
with sd as (
  select distinct scan_date from public.swing_scan_snapshot
),
days as (
  select trade_date, row_number() over (order by trade_date) as dn
  from (
    select distinct trade_date from public.price_daily
    where trade_date >= (select min(scan_date) from sd)
  ) t
),
anchors as (
  select sd.scan_date,
         de.trade_date  as entry_d,
         d5.trade_date  as exit_5d,
         d20.trade_date as exit_20d
  from sd
  join days ds on ds.trade_date = sd.scan_date
  left join days de  on de.dn  = ds.dn + 1
  left join days d5  on d5.dn  = ds.dn + 6
  left join days d20 on d20.dn = ds.dn + 21
),
bench as (
  select a.scan_date,
    round((100.0 * avg(p5.close  / nullif(pe.close, 0) - 1))::numeric, 2) as bench_5d,
    round((100.0 * avg(p20.close / nullif(pe.close, 0) - 1))::numeric, 2) as bench_20d,
    count(*) as bench_n
  from anchors a
  join public.price_daily b  on b.trade_date  = a.scan_date and b.close >= 20
  join public.price_daily pe on pe.symbol = b.symbol and pe.trade_date = a.entry_d  and pe.close > 0
  left join public.price_daily p5  on p5.symbol  = b.symbol and p5.trade_date  = a.exit_5d  and p5.close  > 0
  left join public.price_daily p20 on p20.symbol = b.symbol and p20.trade_date = a.exit_20d and p20.close > 0
  group by a.scan_date
)
select
  s.scan_date, s.symbol, s.is_hot, s.expected_rank,
  s.close as signal_close,
  s.ret_60d_pct, s.dev_ma20_pct,
  f.pxs[1] as entry_px,
  round(100.0 * (f.pxs[6]  / nullif(f.pxs[1], 0) - 1), 2) as ret_5d,
  round(100.0 * (f.pxs[21] / nullif(f.pxs[1], 0) - 1), 2) as ret_20d,
  bm.bench_5d, bm.bench_20d, bm.bench_n,
  round(100.0 * (f.pxs[6]  / nullif(f.pxs[1], 0) - 1) - bm.bench_5d,  2) as excess_5d,
  round(100.0 * (f.pxs[21] / nullif(f.pxs[1], 0) - 1) - bm.bench_20d, 2) as excess_20d
from public.swing_scan_snapshot s
left join lateral (
  select array_agg(t.close order by t.trade_date) as pxs
  from (
    select price_daily.close, price_daily.trade_date
    from public.price_daily
    where price_daily.symbol = s.symbol
      and price_daily.trade_date > s.scan_date
      and price_daily.close > 0
    order by price_daily.trade_date
    limit 21
  ) t
) f on true
left join bench bm on bm.scan_date = s.scan_date;

comment on view public.v_swing_track is
  '波段掃描前向追蹤。錨點與 benchmark 口徑與 v_scan_track 完全一致(次一交易日進場、'
  '掃描日收盤 >= 20 元全市場等權為基準),兩張表的超額報酬才能直接對比。';

-- ── 3. market_bench_daily:標記退役 ──────────────────────────────────
--
-- 2026-08-28 起 v_scan_track 的 benchmark 改成自 price_daily 直算的全市場等權,
-- 這張表的最後一個消費者消失。它本來就已經停更 27 天(無任何 cron 寫入)。
-- 不 drop:1,257 列 TAIEX_TR 報酬指數歷史(2021-06 起)日後若要做長期基準仍有價值,
-- 而且 [[L58]] 明講「大盤基準一律優先用報酬指數」。

comment on table public.market_bench_daily is
  '⚠ 已退役(2026-08-28)。原為 v_scan_track 的 benchmark,現已改成自 price_daily '
  '直算全市場等權(零 cron 依賴)。本表無 cron 寫入,最後一筆 2026-07-31。'
  '保留 TAIEX_TR 報酬指數歷史(2021-06 起)供日後長期基準使用;'
  '要重新啟用必須先補收料 cron,不可直接拿停更的資料當基準。';

-- ── 4. reconcile_audit:寫下誠實現況 ─────────────────────────────────
--
-- 0 列、從未寫入,而同時 price_daily 有 54.3% 的列 is_provisional=true。
-- 不 drop、也不現在實作 reconcile:[[L11]]/[[L17]] 的硬約束是「不能因為切換 API
-- 讓股價跳動」,那個約束由 first-write-wins + 「主力可覆蓋 provisional」已經達成。
-- reconcile_audit 是當初為了「完整 reconciliation」預留的,那個範圍從未進場。

comment on table public.reconcile_audit is
  '⚠ 從未寫入(0 列)。當初為完整 reconciliation 預留,該範圍未實作。'
  '真正的硬約束「不跳價」由 price_daily 的 first-write-wins + 主力可覆蓋 provisional '
  '已達成([[L11]]/[[L17]]),不依賴本表。'
  '注意:price_daily 約 54% 的列 is_provisional=true 且永遠不會被 reconcile —— '
  '該欄位實務上是**來源標記**而非「待確認」狀態,讀的時候不要誤解。';

-- ── 5. check-price-alerts:加閘 ─────────────────────────────────────
--
-- alert_events 0 列,alert_rules 只有 1 列且 enabled=false,但 EF 每 10 分鐘被叫一次
-- (每週約 150 次)全部空轉。沿用 holdings-staleness-backfill 已在用的同一個 pattern。

do $$
declare j record;
begin
  for j in select jobid, command from cron.job where jobname like '%alert%' and active
  loop
    perform cron.alter_job(j.jobid, command := format($fmt$
      do $inner$
      begin
        if exists (select 1 from public.alert_rules where enabled) then
          perform %s;
        end if;
      end
      $inner$;
    $fmt$,
    -- 原指令是 `select net.http_post(...);`,要剝掉尾巴的分號與開頭的 select,
    -- 才能塞進 plpgsql 的 perform。URL / auth / timeout 全部原封不動帶過去。
    regexp_replace(
      regexp_replace(trim(j.command), ';\s*$', ''),
      '^\s*select\s+', '', 'i')));
  end loop;
end $$;
