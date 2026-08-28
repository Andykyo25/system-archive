-- v_scan_track 改用自產 benchmark(2026-08-28)
--
-- 問題:原本 benchmark 取 market_bench_daily 的 TAIEX_TR,但那張表**最後一筆是 2026-07-31
-- 且沒有任何 cron 在寫它**,而 scan_picks 從 2026-08-05 才開始 → 兩者時間軸完全不重疊,
-- 229 筆 pick 的 bench_* / excess_* **全部是 NULL**。
-- 唯一被設計來回答「起漲掃描有沒有贏大盤」的 view,產不出一個非空的超額數字,而且是靜默的:
-- view 照回 229 列,只是欄位全空;v_data_health 的 freshness 清單裡也沒有 market_bench_daily。
--
-- 修法選擇(兩案):
--   (a) 給 market_bench_daily 加一支 cron 每日延伸 TAIEX_TR
--   (b) ✅ 改成「當日收盤 >= 20 元全市場等權」直接從 price_daily 算
-- 選 (b) 的理由:**零新增 cron、永不斷更**(price_daily 是全系統最核心的收料,它死了整個系統都停),
-- 而且等權全市場比大盤指數**更嚴格**(大盤是市值加權,被權值股主導)。
-- 這與 scan_picks 表註解當初「不建實體表 + cron」的取捨完全一致 —— 少一個會安靜死掉的 cron。
--
-- 口徑對齊([[L67]]):benchmark 的進場日與 pick 完全相同 = 掃描日的**次一交易日收盤**,
-- 出場日 = 第 6 / 11 / 21 個交易日收盤。兩邊用同一組交易日錨點,不是各自算各自的。
-- 基準池 = 掃描日當天有 bar 且收盤 >= 20 元的全部個股(與 v_breakout_scan 的價格門檻一致),
-- **不套用產業排除清單** —— benchmark 要的是「不選股會拿到什麼」,不是「同樣濾網下的平均」。
--
-- append-only([[L37]]):既有 16 欄名稱 / 型別 / 順序完全不動,只換 bench_* / excess_* 的
-- 計算來源;尾端 append bench_n(基準池檔數,用來判斷樣本可信度)與 excess_10d(原本缺這個 horizon)。

create or replace view public.v_scan_track as
with sd as (
  select distinct scan_date from public.scan_picks
),
days as (
  select trade_date, row_number() over (order by trade_date) as dn
  from (
    select distinct trade_date from public.price_daily
    where trade_date >= (select min(scan_date) from sd)
  ) t
),
anchors as (
  -- 每個掃描日對應的進場日與三個出場日(全部走市場交易日序,不是日曆日)
  select sd.scan_date,
         de.trade_date  as entry_d,
         d5.trade_date  as exit_5d,
         d10.trade_date as exit_10d,
         d20.trade_date as exit_20d
  from sd
  join days ds on ds.trade_date = sd.scan_date
  left join days de  on de.dn  = ds.dn + 1
  left join days d5  on d5.dn  = ds.dn + 6
  left join days d10 on d10.dn = ds.dn + 11
  left join days d20 on d20.dn = ds.dn + 21
),
bench as (
  select a.scan_date,
    round((100.0 * avg(p5.close  / nullif(pe.close, 0) - 1))::numeric, 2) as bench_5d,
    round((100.0 * avg(p10.close / nullif(pe.close, 0) - 1))::numeric, 2) as bench_10d,
    round((100.0 * avg(p20.close / nullif(pe.close, 0) - 1))::numeric, 2) as bench_20d,
    count(*) as bench_n
  from anchors a
  join public.price_daily b  on b.trade_date  = a.scan_date and b.close >= 20
  join public.price_daily pe on pe.symbol = b.symbol and pe.trade_date = a.entry_d  and pe.close > 0
  left join public.price_daily p5  on p5.symbol  = b.symbol and p5.trade_date  = a.exit_5d  and p5.close  > 0
  left join public.price_daily p10 on p10.symbol = b.symbol and p10.trade_date = a.exit_10d and p10.close > 0
  left join public.price_daily p20 on p20.symbol = b.symbol and p20.trade_date = a.exit_20d and p20.close > 0
  group by a.scan_date
)
select
  p.scan_date,
  p.symbol,
  p.name,
  p.industry_category,
  p.passes_all,
  p.score_total,
  p.close as signal_close,
  f.pxs[1] as entry_px,
  round(100.0 * (f.pxs[6]  / nullif(f.pxs[1], 0) - 1), 2) as ret_5d,
  round(100.0 * (f.pxs[11] / nullif(f.pxs[1], 0) - 1), 2) as ret_10d,
  round(100.0 * (f.pxs[21] / nullif(f.pxs[1], 0) - 1), 2) as ret_20d,
  bm.bench_5d,
  bm.bench_10d,
  bm.bench_20d,
  round(100.0 * (f.pxs[6]  / nullif(f.pxs[1], 0) - 1) - bm.bench_5d,  2) as excess_5d,
  round(100.0 * (f.pxs[21] / nullif(f.pxs[1], 0) - 1) - bm.bench_20d, 2) as excess_20d,
  -- 以下為 append(2026-08-28)
  bm.bench_n,
  round(100.0 * (f.pxs[11] / nullif(f.pxs[1], 0) - 1) - bm.bench_10d, 2) as excess_10d
from public.scan_picks p
left join lateral (
  select array_agg(t.close order by t.trade_date) as pxs
  from (
    select price_daily.close, price_daily.trade_date
    from public.price_daily
    where price_daily.symbol = p.symbol
      and price_daily.trade_date > p.scan_date
      and price_daily.close > 0
    order by price_daily.trade_date
    limit 21
  ) t
) f on true
left join bench bm on bm.scan_date = p.scan_date;

comment on view public.v_scan_track is
  '起漲掃描前向追蹤。benchmark = 掃描日收盤 >= 20 元全市場等權(自 price_daily 直算,零 cron 依賴),'
  '進出場錨點與 pick 完全相同。bench_n = 該日基準池檔數。';
