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

_(後續教訓往下加)_
