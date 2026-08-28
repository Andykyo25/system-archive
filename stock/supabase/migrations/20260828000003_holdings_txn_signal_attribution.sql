-- holdings_transactions 加訊號歸因欄位(2026-08-28)
--
-- 問題:系統有 6 套選股邏輯,但**沒有任何欄位記錄「這筆買進是從哪裡來的」**。
-- 實查:23 筆 BUY 對 scan_picks 做「買進日前 5 交易日內是否被掃出」比對,**0 筆命中**;
-- 2026-08-05(scan_picks 開始累積)之後的 7 筆也是 0。Andy 買過的 10 檔裡有 3 檔曾出現在
-- scan_picks,但**掃出日期全部晚於買進日期**(2408 是 08-10 買、系統 08-13 才掃到)。
-- → 掃描名單與實際下單目前是兩條互不相干的軌道,而且事後永遠無法回推。
--
-- 為什麼非做不可:這是「選股邏輯有沒有效」在真金白銀上唯一可能的答案來源。
-- v_stock_rank 是即時 view,買進當下的名次沒被記錄就永遠回不來(mv_factor_scores 無歷史)。
-- **不可回溯**:即使今天就加,以 6 個月 18 筆的節奏仍要再累積 1.5~2 年才能在統計上
-- 分開「系統選的」與「自己看新聞買的」。每晚一天就晚一天。
--
-- 設計:三個 nullable 欄位,純 append([[L37]]),既有查詢與 view 全不受影響。
--   signal_source — 從哪個畫面/邏輯來的。discretionary = 自己判斷,不是系統推的
--   signal_score  — 當下那個 view 的實際分數(scan 的 score_total / rank 的 weighted_score)
--   signal_rank   — 當下的名次(scan 的當日排名 / rank 的 expected_rank)
-- score / rank 都允許 null:有些來源(news / discretionary)本來就沒有分數,
-- **不可用 0 或任何預設值填充**([[L45]])。

alter table public.holdings_transactions
  add column if not exists signal_source text,
  add column if not exists signal_score  numeric(8,2),
  add column if not exists signal_rank   integer;

alter table public.holdings_transactions
  drop constraint if exists holdings_transactions_signal_source_check;

alter table public.holdings_transactions
  add constraint holdings_transactions_signal_source_check
  check (signal_source is null or signal_source in
    ('scan','rank','swing','holdings_advice','news','discretionary'));

comment on column public.holdings_transactions.signal_source is
  '這筆買進的訊號來源:scan=起漲掃描 / rank=多因子排名 / swing=波段掃描 / '
  'holdings_advice=持股建議 / news=看新聞或消息 / discretionary=自己判斷。'
  'null = 這筆是加欄位之前的歷史資料,不可當成 discretionary。';

comment on column public.holdings_transactions.signal_score is
  '下單當下該來源 view 的實際分數(scan=score_total,rank=weighted_score)。無分數的來源留 null。';

comment on column public.holdings_transactions.signal_rank is
  '下單當下該來源的名次。無名次的來源留 null。';

create index if not exists holdings_transactions_signal_source_idx
  on public.holdings_transactions (signal_source)
  where signal_source is not null;
