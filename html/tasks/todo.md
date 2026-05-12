# 業務出團表系統 v11 — 5 大功能擴充

## 設計確認(已 check in)
- [x] DB:`category` 欄位由 user 自行 migrate
- [x] 進度條:**純展示**,不影響任何勾選操作(見 lessons L1)
- [x] 批次 toolbar:底部 sticky 浮動
- [x] 行事曆:**週視圖**

## 任務清單

### Phase 1:訂單進度條(純前端)
- [x] 1.1 `calcProgress(row)` + `progressDotsHTML(row)`
- [x] 1.2 表格新增「進度」欄(客人後),5 個小圓點 + `n/5`
- [x] 1.3 手機卡片加水平 progress bar
- [x] 1.4 hover tooltip(`✓ 訂金 / ○ 合約...` 形式)
- [x] 1.5 點圓點不觸發任何操作,純展示(符合 lessons L1)

### Phase 2:Inline edit V 標記
- [x] 2.1 `toggleField(id, field)` 函式
- [x] 2.2 9 個 V 欄位 td 加 onclick + `.toggleable-cell` hover 樣式
- [x] 2.3 Optimistic UI:本地先改 → 重 render → API → 失敗回滾 + toast
- [x] 2.4 編輯中禁用 inline toggle(`editId` 有值時擋下並提示)

### Phase 3:批次操作
- [x] 3.1 表頭全選 checkbox,每列 checkbox + `.row-selected` 高亮
- [x] 3.2 `selectedIds` Set + `syncSelectAllState()` 處理 indeterminate
- [x] 3.3 底部 sticky toolbar,slideUp 動畫
- [x] 3.4 標記 V / 取消 V 雙下拉,各 7 項
- [x] 3.5 批次刪除(supabase `.in()`)
- [x] 3.6 取消選取按鈕 + 切 Tab/篩選時自動清空

### Phase 4:行程分類欄位 + 顏色標籤
- [x] 4.1 DB column 由 user 自行 migrate
- [x] 4.2 表單加 input + `<datalist>`(預選 7 項可自填)
- [x] 4.3 `categoryColor()` 用簡單 hash → 固定 HSL
- [x] 4.4 表格 + 手機卡片在行程名前加 badge
- [~] 4.5 chips 分類篩選(本次未做,留待後續)
- [x] 4.6 CSV 匯出加「分類」欄
- [~] 4.7 不加進 TOGGLEABLE_COLS(badge 內嵌在「行程」欄)

### Phase 5:週視圖行事曆
- [x] 5.1 控制列加「列表 / 週曆」切換 btn-group
- [x] 5.2 週導航(◀ 上週 / 本週 / 下週 ▶)
- [x] 5.3 7 天 CSS grid,each cell:日期 header + events
- [x] 5.4 事件色塊用 categoryColor(預設藍)
- [x] 5.5 點色塊 → `editRecord()` 開表單編輯
- [x] 5.6 手機版自動單欄堆疊(`@media max-width:992px`)
- [x] 5.7 視圖切換不重 fetch,view 偏好存 localStorage
- [x] 5.8 額外:今日格高亮、週末底色、過去日期淡化

## Review

### 改動規模
| 指標 | 變化 |
|---|---|
| 檔案行數 | 940 → **1369**(+429) |
| 新 function 數 | +14(含 startOfWeek, calcProgress, toggleField, batch×2, switchView, renderWeekView 等) |
| 新狀態變數 | `selectedIds`, `currentView`, `weekStart` |
| 新 CSS 類 | progress-mini / m-progress / toggleable-cell / batch-toolbar / row-selected / category-badge / week-* |
| DB 改動 | `sales_records.category text`(user 自跑) |

### 設計關鍵決策
- **進度條純展示**:遵守 lessons L1,不卡業務原本的自由勾選
- **Optimistic UI**:inline edit / 批次 update 都先改本地再打 API,失敗回滾
- **批次後重抓**:刪除走 `loadData()` 確保資料正確;標記走樂觀更新
- **切 Tab/篩選時清空 selection**:避免選了看不到的困惑
- **categoryColor 用 hash**:同分類永遠同色,不存 DB
- **週視圖切換偏好持久化**:`localStorage.currentView`
- **body class 切換視圖**:用 CSS `.view-week .table-container { display:none }` 而非 JS 操作 inline style,更乾淨且不破壞 @media

### 風險 / 後續觀察
- **Realtime 衝突**:其他人改資料時 setupRealtime 會觸發 loadData → applyFilters。在 inline edit 過程中可能與 optimistic 結果競爭。`editId` 已擋住 form 編輯,但 inline 不擋。實測若有問題再加 lock。
- **批次選取跨頁面行為**:目前切 Tab 自動清空。如使用者想「跨月份批次操作」要再設計。
- **週視圖事件密集**:單日太多團時 `max-height:380px` 會出現 scroll。可能要做「更多 +N」收合。
- **未做的細項**:分類 chips 篩選、TOGGLEABLE_COLS 整合分類欄。等使用者反饋再補。

### 已 lessons 化
- L1:狀態指示器 ≠ 流程鎖(進度條設計原則)
