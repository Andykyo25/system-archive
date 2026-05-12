# 業務出團表系統 — 修正計畫

## 任務清單

- [x] **1. 修通知 query 的 `.or()` 用法**
- [x] **2. 修月度圖表 timezone 風險**
- [x] **3. 客戶排行改用 allData**
- [x] **4. 空狀態 colspan 動態化**
- [x] **5. 預設排序改成降序 + 同步排序圖示**
- [x] **6. 手機卡片補上預估/實際業績**

## Review

### 改動摘要
| # | 檔案位置 | 內容 |
|---|---|---|
| 1 | `fetchNotifications()` | `.or()` 兩個參數合併為單字串,讓「開票日預警」規則生效 |
| 2 | `renderPerformanceDashboard()` | `getMonth()` 改成字串切片,避開 timezone 偏移 |
| 3 | `renderCustomerAnalysis()` | 改用 `allData`,TOP 5 變成全局排行榜 |
| 4 | `renderAll()` 空狀態 | `colspan` 改為 `21 - hiddenCols.size`,跟著隱藏欄位調整 |
| 5 | `sortData()` / 全域 | `sortAsc=false`,抽出 `updateSortIcons()`,`renderAll()` 開頭呼叫一次同步圖示 |
| 6 | 手機卡片 | 加上預估 / 實際業績兩欄 |

### 影響範圍
- **資料層**:只動 query 字串,DB schema、欄位、RLS 都沒動到
- **顯示層**:加欄位、修圖示、補空狀態 colspan,不破壞既有 layout
- **狀態變數**:`sortAsc` 預設值從 true → false,初次載入會降序顯示

### 風險 / 後續可觀察
- 通知系統 query 改動後,務必實測有訂單在 3 天內開票但未入名單的 case 會不會跳出來
- 客戶排行從「篩選後」改成「全局」,使用者習慣可能要重新適應 — 若反饋希望跟著篩選變動,只要把 `allData` 改回 `currentData` 即可
- timezone 修正只動到圖表月份分箱,不影響其他日期邏輯(篩選/排序都是字串比較)
