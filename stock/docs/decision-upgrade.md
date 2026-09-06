# 起漲決策與 UI 更新（2026-09-06）

本輪完成程式與本機驗證，尚未部署。入口仍是 `/scan`。

部署沿用既有流程：推送 GitHub 後由 Railway 建置及部署 Next.js，資料庫與 Edge Functions 位於 Supabase。此專案供本人使用，不設帳號、密碼或網站登入門檻。

## 使用流程

1. 搜尋／篩選突破候選，查看五條件與資料日。
2. 展開「查看依據與建立計畫」，填寫買入區間、停損、期限、進場依據及退出規則。
3. 保存時由資料庫重新查詢掃描快照；候選已更新、資料過舊或涵蓋不足時拒絕保存。
4. 在「我的交易計畫」記錄已成交買入，寫入既有持股帳並以 plan_id 連回原計畫。
5. 在歷史計畫對照實際成交是否落於價格區間與期限。賣出仍使用持股管理；此頁不送單、不自動停損。

可勾選「一併估算可投入股數」，自行填寫單股／產業集中度與滑價假設。系統取可用現金、單筆風險預算、單股及產業集中度四個限制中最低的股數；資料或設定不完整時不提供估算。保存時重新取得帳戶資料，一次凍結估算輸入、結果與交易計畫。

股數估算採買入上限，計入設定手續費、賣出稅與填寫的雙邊滑價；本金沿用既有設定。它不預留資金、不處理所有持股同時停損的組合損失，也不保證跳空或流動性不足時的損失上限。費率採比例估算，未涵蓋券商最小費用。歷史計畫另顯示成交股數是否超過建立時估算；刪除誤填的連結買入會在同一交易恢復原計畫等待狀態。

## 資料與回測口徑

- `breakout-v3-adjusted`：權重不變；技術價格還原，再換回訊號日的實際價格單位。前高需完整 20 根，月線斜率需完整 25 根；平盤 RSI 為 50。外資標籤需逐檔完整五個市場交易日。
- 舊 scan_picks 的 strategy_version 保持 NULL；新增紀錄才使用 v3。不可把舊樣本改標新版。
- `v_scan_track_v2` 是未扣成本的還原收盤報酬觀察，不是成交回測。個股與基準共用市場日期；基準任一端點缺料就暫停該組超額，並保留缺料數。這可能使觀察數少於候選數，屬刻意設計。
- 每日候選先取平均，再跨掃描日平均；沒有把重疊五日窗包裝成獨立樣本或上漲機率。
- 即時報價僅使用供應者的有效 `tlong`，不以抓取時間替舊行情刷新時間戳；委買賣中點與實際成交分開標記，僅新鮮實際成交可觸發提醒。

## 回測變更

目前 `run-backtest` 仍驗證既有多因子排名，並非起漲掃描策略的交易績效。

- `daily-stop-v4`／`daily-cash-ledger-v1` 只用當日前已知資料計算停損；進場日也受保護。盤中限價成交採先進場再測低點的保守假設。
- 每日記錄現金、限價單保留預算、持股估值及總資產。未成交配置保留現金；延後賣出的資金待實際成交才可使用，期末仍無法賣出者保留為未平倉，不捏造成交。
- 缺當日收盤價時沿用最後已知價格並標記缺價天數；不使用未來報價。必要資料嚴重缺失時回報失敗。
- 最大回撤與 Sharpe 用每日收盤淨值；Sharpe 年化係數為 252，無風險利率設為 0。月報酬取月末帳戶淨值，包含未平倉估值；勝率只計扣成本後的已平倉交易。
- `equity_dates` 對應每日曲線，`rebalance_dates` 保留換股日期。結果頁顯示期末現金／持股與缺價狀態；版本、日期或基準不一致時不疊圖。
- 仍採還原價格的可分割單位，不含滑價、市場衝擊、整股／整張限制或最小手續費。假設同日開盤賣出所得可用於開盤買入；未平倉估值尚未扣未來賣出成本。`close` 模式使用訊號日收盤，只作診斷。
- 不改寫舊 stored runs。交易明細的價差欄維持未扣成本並明確標示，總績效使用新現金帳中的實際名目金額費用。

## 上線前與部署順序

1. 備份正式 schema，保存 `pg_get_viewdef('public.v_breakout_scan'::regclass, true)`、scan_picks 欄位 default、三支 EF 舊版本、Web commit 與 `check-price-alerts` cron 的原 schedule／command。確認正式 migration history 與本機一致。
2. 沿用 Railway 既有 Supabase 環境變數（網站伺服器使用 `NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`），不需新增登入帳號或密碼。服務金鑰只在伺服器使用。
3. 依序套用 `20260906000001` 到 `20260906000006` 六支 migrations：掃描還原、前向觀察、交易計畫、提醒重試、風險估算、成交刪除生命週期。保留舊觀察 view 與交易資料，不追溯修改既有凍結樣本。提醒 migration 若缺少 cron job 或 command 不含已知判斷會中止，須先核對正式環境差異。
4. 部署 `fetch-yahoo-intraday`、`check-price-alerts` 與 `run-backtest`。三者共用 `_shared/authorize.ts`，只接受執行環境 service key 或 Vault 中的 `edge_function_auth`，兩把 key 可不同。`read_edge_function_auth` RPC 僅 service_role 可執行，不接受只解碼後自稱 service_role 的 JWT；保持 gateway JWT 驗證設定。新提醒排程允許待送事件在收盤後重試，新事件仍限定有效盤中行情。
5. 完成 Supabase 更新後，推送到 Railway 已連結的 GitHub 部署分支，由 Railway 依現有 Dockerfile 自動建置並執行 standalone server。確認網站可直接開啟，保存計畫與記錄成交皆不要求登入。
6. 正式抽查：除權息個股、價格覆蓋、五日籌碼、舊樣本版本、新計畫與風險快照、成交／刪除連結，以及新回測每日資產等於現金加持股。Telegram 端到端測試須有明確發送授權。

本機沒有可用的正式 Supabase 設定，未執行遠端 migrations、變更排程、發送 Telegram 或部署網站，不能把本機 fixture 通過當成正式行情驗證。

目前 repository 的 Railway／Docker 設定只建置與啟動網站，沒有執行 Supabase migrations 或部署 Edge Functions 的步驟。因此六支 migrations 與三支 Edge Functions 需在 Supabase 另外套用；單純推送 GitHub 不會完成這部分更新。

## 回復

- 回復 Web 與 EF 至上線前版本。
- 恢復先前保存的掃描 view 定義，scan_picks.strategy_version default 改回 NULL（或上線前 default），避免舊策略產生的新樣本誤標 v3。
- 保留新計畫、風險快照、plan_id 及提醒事件，避免刪除稽核記錄。舊提醒 EF 不讀新 pending queue，回復前先盤點尚未送達事件，恢復先前 cron schedule／command；不自動批量重送。
- `v_scan_track_v2` 不取代舊 view，可保留待修正後再啟用。

## 驗證命令

```sh
npm ci
npm test
npx tsc --noEmit
npm run build
deno check --node-modules-dir=none --no-lock supabase/functions/run-backtest/index.ts supabase/functions/check-price-alerts/index.ts supabase/functions/fetch-yahoo-intraday/index.ts
```

33 項 Node 測試涵蓋實際 PGlite SQL、掃描除權息、資料缺漏、原子成交與刪除、通知 lease／cron、報價時間、Edge Function 服務授權、風險限制、逐日現金帳與圖表口徑。

`tests/ui-smoke.mjs` 使用本機假資料 HTTP server 與 headless browser；需 Playwright（可由 PLAYWRIGHT_MODULE 指定 module 絕對路徑）及 BROWSER_EXECUTABLE。不連線正式 Supabase，測試結束會關閉 server。驗證 1440px 桌面、390px 手機、搜尋／篩選、風險快照、保存計畫、成交偏差提示、錯誤狀態、每日回測與版本對比，檢查瀏覽器錯誤與水平溢出。截圖位於 `.next/ui-qa/`，資料均為示範。

先執行 build，再設定 `UI_SMOKE_MODE=production` 執行 UI 測試，會依 Dockerfile 的檔案配置啟動 `.next/standalone/server.js`，驗證正式模式下免登入讀取與寫入流程。

全專案 lint 尚有原有錯誤，本次相關檔案檢查無新增 errors。通知採至少送達一次語意：Telegram 已收件但回應逾時時，重試可能重複；事件編號可用於識別。
