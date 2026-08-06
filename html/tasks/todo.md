# 業務出團表 v12 — 合約截圖強制上傳 + 移除網卡

計畫已 check in（plan mode 核准）：合約完成與否改看 `contractImage`（Storage 路徑）是否有值，不再用 boolean 勾選;網卡欄位全移除。DB 舊欄位 `contractUploaded` / `simCard` 保留不刪。

## 任務清單

### Phase 1:Supabase migration
- [x] 1.1 `sales_records` 加 `"contractImage" text`
- [x] 1.2 建 private bucket `contracts`（10MB、image/*）
- [x] 1.3 storage.objects 4 條 policy（insert/select/update/delete，限本人資料夾）
- [x] 1.4 SQL 驗證欄位 / bucket / policy + get_advisors

### Phase 2:表單
- [x] 2.1 移除 f_contractUploaded、f_simCard
- [x] 2.2 備註前加「合約截圖」file input + 查看/移除現有截圖 UI
- [x] 2.3 saveRecord:先上傳再存檔、失敗中止、換圖刪舊檔
- [x] 2.4 editRecord / resetForm / duplicateRecord 帶入與清空截圖狀態

### Phase 3:表格 / 手機卡片
- [x] 3.1 表頭 合約上傳→合約截圖、刪網卡欄、colspan 23→22
- [x] 3.2 儲存格:有圖「查看」（signed URL）/ 無圖「上傳」（就地上傳）
- [x] 3.3 手機卡片加 查看/上傳合約 按鈕
- [x] 3.4 編輯模式中禁用就地上傳（同 toggleField 守門）

### Phase 4:邏輯接點
- [x] 4.1 PROGRESS_STEPS 改 check function
- [x] 4.2 fetchNotifications 改 contractImage.is.null
- [x] 4.3 批次 toolbar 移除合約上傳兩項
- [x] 4.4 TOGGLEABLE_COLS / FIELD_LABELS / FORM_FIELD_IDS 清理 + hiddenCols 過期 key 清理
- [x] 4.5 exportToCSV 改欄位
- [x] 4.6 deleteRecord / batchDelete 一併刪 Storage 檔

### Phase 6:舊勾選 grandfather（使用者追加,2026-07-27）
- [x] 6.1 `contractDone(r)` 統一判定:有截圖 或 舊勾選(contractUploaded=true)即完成
- [x] 6.2 套用到 進度條 / 通知(query + client) / CSV / 表格儲存格 / 手機卡片
- [x] 6.3 表格儲存格三態:查看(有圖) / 綠V(舊勾選,tooltip 註明) / 上傳(皆無)
- [x] 6.4 驗證:135 筆舊V 顯示綠V、128 筆顯示上傳鈕(合計263)、通知剩真正未辦的 2 筆

### Phase 5:驗證
- [x] 5.1 JS 語法檢查（無 node，改由瀏覽器實際載入驗證，console 零錯誤）
- [x] 5.2 Browser pane 預覽:263 筆實資料渲染、表頭 22 欄、批次選單無合約項、通知徽章含「合約截圖未上傳」
- [x] 5.3 Storage 端對端:上傳 → signed URL fetch 200 → 刪除,全通過（RLS 生效,路徑落在本人資料夾）
- [ ] 5.4 使用者實測:表單/表格實際上傳一張截圖、點「查看」、手機寬度操作

## Review

### 改動摘要
| 項目 | 內容 |
|---|---|
| DB | `sales_records."contractImage" text`（migration: `contract_image_storage`）|
| Storage | private bucket `contracts`（10MB、image/*）+ 4 條 per-user policy |
| 舊欄位 | `contractUploaded` / `simCard` DB 保留、前端全移除引用 |
| 前端 | 表單 file input（備註前）、表格/手機卡片 查看+就地上傳、進度條/通知/CSV/批次全改接 contractImage |

### 設計關鍵決策
- **完成判定 `contractDone()`**:有截圖,或 v12 上線(2026-07-27)前的舊勾選(grandfather)。上線後 UI 已無法再寫 contractUploaded,故不需比日期,`contractUploaded === true` 必為舊資料——新紀錄自然只認截圖
- **Private bucket + signed URL**:合約含個資,不開 public;查看走 1hr signed URL,先開視窗再導向避免 popup blocker
- **Storage RLS 與資料表同構**:路徑第一層 = `auth.uid()`,各業務只碰得到自己的檔案
- **就地上傳**:表格/手機卡片無圖時直接選檔上傳,不用進編輯表單（降低業務上傳門檻）
- **孤兒檔防護**:存檔失敗刪新檔、換圖/刪紀錄/批次刪除都 best-effort 清 Storage 舊檔
- **hiddenCols 過期 key 開機清理**:避免 localStorage 殘留造成 colspan 算錯

### 風險 / 後續觀察
- ~~舊資料勾過 V 的近期出團會出現「合約截圖未上傳」提醒~~ → 已依使用者指示改為 grandfather(Phase 6)
- Supabase advisors 既有 WARN:Auth 未開啟外洩密碼保護（與本次無關,可在 Dashboard → Auth 開啟）
- iPhone HEIC:accept="image/*" 下 Safari 通常自動轉 JPEG;若有業務回報上傳後無法檢視再處理

---

## 補丁:LINE 通知誤報「合約尚未上傳」(2026-08-06)

**症狀**:業務收到 LINE 每日提醒,張文馨/HKG6HB0809A8張家界八日(出發 2026-08-09)已上傳截圖,仍被標「❌ 合約尚未上傳」。

**根因**:v12 改截圖制時只同步了前端,**Supabase Edge Function `line-notify` 漏改** — 仍只判斷 `!contractUploaded`,完全沒讀 `contractImage`。前端 `contractDone()` 與頁內通知查詢都已正確,唯獨 EF 是另一份獨立程式碼,不在 html 檔內,當時沒被掃到。

- [x] EF 判定改為 `contractDone(r) = !!r.contractImage || r.contractUploaded === true`(與前端同規則)
- [x] 部署 Supabase `travel record` → line-notify **v11 → v12**(verify_jwt 維持 false,pg_cron 觸發不受影響)
- [x] SQL 模擬驗證:今日出發預警/開票預警皆 0 筆,誤報消失
- [x] 本地原始碼同步(原檔停在最早的單人 `'V'` 字串版,與線上差 10 個版本)
- [x] `line-notify/` 從 `AI/` 上層搬進本 repo,commit `3ccb929` 已推送
- [ ] 明早 09:00(cron `0 1 * * *` UTC)實際推播確認

**教訓**:合約完成判定現在有**兩份實作**(前端 html + Edge Function)。往後動這條規則,兩邊都要改;其他同狀況欄位(deposit/balance/preTripNotify/list)同理。
