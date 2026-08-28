-- recompute_adj_factor() 排進 cron(2026-08-28)
--
-- 問題:`fetch-corporate-action-weekly-b1..b3`(週六 21/22/23)每週收除權息,近 90 天收了
-- **404 筆**,但把它轉成還原係數的 `recompute_adj_factor(p_symbol)` **沒有任何 cron 在叫**。
-- 收料與消費之間是斷的 —— 這是「收了沒進決策路徑」裡最貴的一筆:
-- 選股因子與 backtest 全部走 close × adj_factor(Phase 0 的地基),係數不更新
-- 等於除權息後的價格序列會出現假性跳水,而且不會報錯。
--
-- 排程:週日 02:00。週六 21/22/23 的三批 corporate_action 全部跑完之後,
-- 且早於週日 19:00 的 fundamentals。與週日 01:00 的 shareholding-b4 錯開一小時。
--
-- 範圍:近 400 天內有除權息紀錄的 symbol。不做全表(345 檔)的理由是把單次執行時間壓住;
-- 400 天覆蓋所有現行 view 會用到的視窗(最長 v_breakout_scan 的 120 天 + 緩衝)。
-- 歷史更早的係數在當初 backfill 時已算過,不會因為沒重算而漂移。
--
-- [[L35]]:mutation 與驗證分開 —— 這裡只呼叫 function,不在同一個 statement 裡查結果。
-- 驗證走下一輪 /health 或手動查 price_daily 的 adj_factor 分布。
--
-- rollback: select cron.unschedule('recompute-adj-factor-weekly');

select cron.schedule('recompute-adj-factor-weekly', '0 2 * * 0', $job$
  do $inner$
  declare s text;
  begin
    for s in
      select distinct symbol
      from public.stock_corporate_action
      where action_date >= current_date - 400
    loop
      perform public.recompute_adj_factor(s);
    end loop;
  end
  $inner$;
$job$);
