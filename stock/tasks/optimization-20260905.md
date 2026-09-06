# 2026-09-05 起漲決策與 UI 優化

本輪交付：可信的掃描資料、可保存的人工交易計畫、可辨識的證據狀態。
保留既有評分權重，不宣稱新的交易優勢；不自動送單。

- [x] 掃描指標還原價格、逐檔籌碼時間與完整視窗。
- [x] 前向追蹤統一市場交易日與還原報酬，區分缺料與未到期。
- [x] 交易計畫保存訊號快照、進場區間、停損、期限與出場依據。
- [x] 部位估算整合現金、風險比例、集中度、費用及滑價假設，凍結輸入與結果。
- [x] 成交連回計畫，顯示價格／期限／股數偏差；刪除誤填買入後恢復計畫。
- [x] 起漲頁搜尋／篩選／下一步操作，清楚呈現模型與資料限制。
- [x] 提醒採可重試事件並檢查報價時間。
- [x] 回測修正停損時序、逐日現金／持股估值與延後成交；未平倉不捏造成交。
- [x] 回測圖表使用每日日期、帳戶月報酬，阻擋不同版本／日期／基準疊圖。
- [x] 執行單元測試、SQL fixture 驗證、TypeScript、lint、build 與 UI 檢視。

## 部署與回復

先在 Supabase 套用新增 migrations 並部署 Edge Functions，再推送 GitHub 觸發 Railway 部署 Next.js。保留舊追蹤 view；新版使用獨立名稱。
上線前保存目前 v_breakout_scan 定義；必要時恢復該定義與舊應用／Edge Function 版本。
新建計畫及事件資料保留，不以刪表方式回復。尚無正式環境連線，不把本機通過當成正式驗證。

## 2026-09-06 review

- 33 個 Node 測試通過（含 PGlite 實際 SQL）；涵蓋除權息、缺報價、重複成交／刪除、通知 lease／cron、報價時間、停損時序、逐日現金帳、Edge Function 服務授權、風險估算與圖表口徑。依使用者決策移除網站登入及其單元測試。
- TypeScript、Next.js production build、三支 Edge Functions 的 Deno check 通過。
- 本次相關檔案 ESLint 0 errors，持股 actions 有 3 個既有 warnings。
- 全專案 ESLint 未通過：會掃入 .claude/worktrees，另有既有 React purity / any 型別錯誤；未為了綠燈關閉規則或順手重寫舊模組。
- 以獨立 HTTP fixture 作 UI 驗證：1440px 桌面／390px 手機、搜尋、篩選、空結果、風險快照、建立計畫、成交偏差、追蹤失敗提示、每日回測與版本對比，無瀏覽器錯誤及水平溢出。未使用正式行情、未發 Telegram、未寫正式資料庫。
- 維持原定單人使用、無帳號密碼的網站流程；移除上一輪新增的登入 proxy 與 Server Action 登入檢查。Supabase 金鑰仍由伺服器使用。
- production standalone（對齊 Railway Dockerfile）以隔離假資料驗證免登入讀取、保存計畫與記錄成交通過。
- 安裝使用既有 lockfile，另新增 @electric-sql/pglite 開發測試依賴。實際 lockfile Next.js 為 16.2.11，並已讀取其內附 docs。

## 後續（本輪不宣稱已完成）

- 正式環境 migration／Edge Function／Web 部署及真實資料核對。
- 起漲掃描策略接到交易模擬；目前每日帳務回測仍使用多因子排名。
- 回測加入滑價、流動性與交易單位／最小費用限制；整體持股同時停損的組合風險。
- 按計畫追蹤實際賣出與分批出場；目前 plan_id 連結首次 BUY，SELL 仍走既有持股管理。
- 完整策略走勢／市場狀態驗證，累積新版本前向樣本後再評估權重。
