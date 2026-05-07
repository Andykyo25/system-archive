# Lessons Learned

> 每次被使用者糾正後,把該模式寫進這裡。每次開新 session 先翻這份。
> 格式:**問題模式** → **正確做法** → **為什麼**(必要時加日期/出處)

---

## 來自上個版本(系統重啟前)的核心教訓

### L01 — 不能掃全市場
**問題**:上個版本想處理全市場 → API quota 爆 / 被 rate limit / 資料不準
**做法**:這個版本只處理 `holdings ∪ watchlist`(< 30 檔),從架構上把資料量壓死
**為什麼**:免費 API 的 quota 撐不住全市場日 fetch

### L02 — 不可在 user-facing path 做外部 API 呼叫
**問題**:即時取數讓使用者看到 API 失敗 / 跳價 / 慢
**做法**:user 路徑只讀 Supabase,所有外部 fetch 都在排程裡完成
**為什麼**:user 體驗與 API 穩定性必須解耦

### L03 — Source 切換不可造成價格跳動
**問題**:多 source fallback 時,使用者會看到同一檔同一天價格在不同 source 之間跳
**做法**:Primary-Lock + Provisional Fill + Reconciliation
- 主力寫入後 lock,備案只能 fill 空缺且標記 `is_provisional`
- 主力恢復後 reconcile,所有變更進 `reconcile_audit`
**為什麼**:資料準確性 > 完整性。寧可標記「待確認」也不要呈現不一致數字

---

## M2 接 TWSE/TPEX 主力資料源實做後

### L04 — TWSE / TPEX 免費 OpenAPI 關鍵欄位差異
**摘要**:
- TWSE `/v1/exchangeReport/STOCK_DAY_ALL` ~1350 檔(含 ETF / 特別股)。欄位 `Code`、`OpeningPrice`、`HighestPrice`、`LowestPrice`、`ClosingPrice`、`TradeVolume`
- TPEX `/openapi/v1/tpex_mainboard_daily_close_quotes` ~5700+ 筆(含權證)。欄位 `SecuritiesCompanyCode`、`Open`、`High`、`Low`、`Close`、`TradingShares`
- 兩家 `Date` 都是民國年 7 碼字串(`1150506` = 2026-05-06),需轉 ISO
**做法**:Edge Function 內各自有 `parseTWSE` / `parseTPEX`,輸出 normalized `PriceRow`

### L05 — Edge Function 認證:不要拿 SUPABASE_SERVICE_ROLE_KEY env 直接比對 Authorization header
**問題**:`req.headers.get("authorization") === "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` 永遠 401(env 內值與外部 JWT 不一致,可能因 Supabase 內部 key rotation 或新格式)
**做法**:`verify_jwt: true` 已讓平台先驗簽,函式只 decode JWT payload 確認 `role === 'service_role'` 即可
**為什麼**:平台的 `SUPABASE_SERVICE_ROLE_KEY` 自動注入值不一定等於使用者 dashboard 拿到的那把 JWT

### L06 — TPEX endpoint payload 大(~5MB),偶發 "error reading a body from connection"
**做法**:**每個 source 一筆 fetch_log,獨立 try/catch**;TPEX 失敗不會中斷 TWSE。失敗的留 dead letter,讓 reconcile job 補洞
**為什麼**:多 source 整條 pipeline 死 = 資料缺口擴大;隔離才能 graceful degrade

### L07 — pg_net 是 async,回應在 `net._http_response` 表
**做法**:cron 觸發的 Edge Function 觀測點是 `public.fetch_log`,不是 `net._http_response`。寫入 fetch_log 是 Edge Function 的職責,讓監控有單一入口
**為什麼**:`net._http_response` 只記錄 HTTP 層狀態(200 / 5xx),不知道函式內部成不成功
