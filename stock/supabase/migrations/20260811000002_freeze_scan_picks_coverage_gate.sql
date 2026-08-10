-- freeze-scan-picks 加涵蓋率前置閘(2026-08-11)
--
-- 問題:scan_picks 的價值全在「凍結當時真的選了誰」。如果當日 price_daily 只收到
-- 524 檔(2026-08-10 實況,正常約 2300),凍下去的就不是「當天最好的標的」,
-- 而是「當天剛好有收到料的那 524 檔裡最好的」—— 母體不同,樣本作廢,而且**無法事後辨識**:
-- 表裡不會記載當時池子多大。這正是 L60(池子大小不一致讓回測結論反向)的前向版本。
--
-- 06:45 補洞失敗時 07:00 照凍是唯一會留下永久污染的一步(價格事後補得回來,
-- 凍結的決策補不回來),所以閘門放在這裡而不是別處。
--
-- 口徑與 v_data_health 的 coverage 檢查一致(最新交易日檔數 vs 近 20 日中位 80%),
-- 刻意共用同一個門檻:監控說「不健康」的日子,就是不該凍的日子。
--
-- 不凍不需要補救動作:隔天 06:45 補洞會把資料補回來,但當天的 scan_date 就永久留空 ——
-- 這是刻意的取捨,寧可少一天樣本,不要一天髒樣本。
--
-- rollback:重跑 20260803000001(或任何一版原始 freeze cron 定義),
-- 即以無 guard 的裸 insert 版本覆蓋同名 job。

select cron.schedule(
  'freeze-scan-picks-daily',
  '0 7 * * 1-6',
  $$
  do $body$
  declare
    latest_n numeric;
    median_n numeric;
  begin
    with cov as (
      select trade_date, count(*)::numeric as n
      from public.price_daily
      where trade_date >= (select max(trade_date) - 20 from public.price_daily)
      group by trade_date
    )
    select (select n from cov order by trade_date desc limit 1),
           (select percentile_cont(0.5) within group (order by n) from cov)
      into latest_n, median_n;

    if median_n is not null and median_n > 0 and latest_n < median_n * 0.8 then
      raise notice 'freeze-scan-picks skipped: latest_n=% median_n=%', latest_n, median_n;
      return;
    end if;

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
  end $body$;
  $$
);
