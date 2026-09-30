-- L32 同步:score_universe_at 的 expected_rank 補上線上 v_stock_rank 早已有的「有基本面優先」(2026-09-30)
--
-- 問題(M10 回測分析發現):
--   線上 v_stock_rank :row_number() over (order by (fund_count_total > 0) desc, weighted_score desc nulls last, symbol)
--   回測 score_universe_at:row_number() over (order by fs.ws desc nulls last, fs.symbol asc)
--   → 函式漏了「有基本面優先」。2026-07 起 332 檔 ETF 才開始有價格歷史,累積到剛好能評
--     1 條動能 + 1 條反轉(chip / fund 全 null → 權重 reallocate 給 mom + rev)→ 通通拿
--     weighted_score = 100;2026-08-21 的 Top10 全是 ETF(含 3 檔槓桿型),M10 最後一窗因此
--     不是選股結果。線上同日 Top10 沒有 ETF(fund_count_total = 0 一律排最後)。
--
-- 為何不是「排除 ETF」或「最低維度門檻」(先前提案,查證後放棄):
--   1. 歷史 run 本來就會選 ETF(HONEST-v2 2023 top5 7/55 筆、B3-base-3yr-t10 15/351 筆;皆
--      0050 / 0056 / 00878 等長歷史 ETF)→ 整個排除會讓舊基準無法重現、新舊不可比
--   2. 絕對門檻會誤殺 2023 上半年(全市場尚無基本面、歷史不足,全體 fund_count_total = 0);
--      對齊線上排序則不會:全體 fund_count_total = 0 時 (fund_count_total > 0) 為常數,排序不變
--
-- 影響範圍:只有 expected_rank 的排序鍵;weighted_score 與其餘欄位、ACL、volatility 不變。
--   修改前快照(11 個日期):2024-06-28、2025-05-02 / 06-30 / 09-22、2026-03-27 / 04-28 / 05-27 /
--   07-24 的 Top10 都沒有無基本面標的 → Top10 不變;2023-02-01、2023-04-28 全體無基本面 → 排序不變;
--   只有 2026-08-21 的 Top10 從 10 檔 ETF 變回股票。
--   已存 backtest_runs / backtest_trades 不改寫(append-only)。
--
-- 實作方式:同 20260703000004 —— pg_get_functiondef + replace + execute(不手抄 20K 字元 SQL,L49 精神)。
--   目標片段須恰出現 1 次(否則 raise exception,不動任何東西);idempotent(已含新片段就跳過)。
--   CREATE OR REPLACE 保留 ACL(僅 postgres / service_role)與 comment。
--
-- 迴歸驗證(apply 後必查,與 apply 分開呼叫,L35),對上述 11 日:
--   (a) 分數指紋(除 expected_rank 外全欄位)逐日不變   (b) 有基本面標的相對排序指紋不變
--   (c) 無基本面標的相對排序指紋不變                   (d) 2023 兩日整體排序指紋不變
--   (e) 2026-08-21 Top10 不含 ETF
--   (f) md5(replace(新定義, 新片段, 舊片段)) = 修改前定義 md5(2990a42767e836cf384765b371a409c6)
--   註:L39 錨點指紋(2026-07-03 的 fp_2025 / fp_2024)算法未留紀錄、無法還原,本次改用自建快照。
--
-- rollback:把下方 do 區塊的 old_frag / new_frag 對調後 re-execute(反向 replace,(f) 已證明可逐位元還原)。

do $$
declare
  src      text;
  n        int;
  old_frag constant text := 'row_number() over (order by fs.ws desc nulls last, fs.symbol asc) as expected_rank';
  new_frag constant text := 'row_number() over (order by (fs.fund_count_total_v > 0) desc, fs.ws desc nulls last, fs.symbol asc) as expected_rank';
begin
  src := pg_get_functiondef('public.score_universe_at(date)'::regprocedure);
  if position(new_frag in src) > 0 then
    raise notice 'score_universe_at already fund-first; skip';
    return;
  end if;
  n := (length(src) - length(replace(src, old_frag, ''))) / length(old_frag);
  if n <> 1 then
    raise exception 'score_universe_at: expected exactly 1 occurrence of the expected_rank ordering, found %', n;
  end if;
  execute replace(src, old_frag, new_frag);
end $$;
