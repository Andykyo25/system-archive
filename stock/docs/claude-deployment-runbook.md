# Claude 部署執行手冊：起漲決策與 UI 更新

建立日期：2026-09-06。這是交給具有 Supabase 連線能力的 Claude 執行的文件，不代表正式部署已完成。

## 1. 目標與已確認決策

完成這一輪本機修改的正式部署，順序為：

**核對環境與保留回復資料 → Supabase migrations → Supabase Edge Functions → GitHub commit／push → Railway 建置／部署 → 驗證並回報。**

- 網站單人使用，不新增帳號、密碼、登入 proxy 或網站登入檢查，不要求任何 `APP_ACCESS_*` 變數。
- 網站為 Next.js，GitHub 推送觸發既有 Railway 部署；資料庫、Edge Functions、pg_cron 與 Vault 位於 Supabase。
- 保留 Supabase 服務間授權和 server-only 金鑰用途；移除網站登入不等於停用 Edge Function JWT 驗證或公開服務金鑰。
- 保留原選股權重、歷史交易、舊回測與舊凍結樣本。此次部署不包含重新設計策略、升級依賴或大量回填行情。
- 不為部署驗證發送額外 Telegram 測試訊息或建立虛構持股交易。部署後恢復原本已啟用的正式排程。
- 使用者貼上本文件末尾的提示詞後，即可在核對環境後執行本輪部署，不需逐步重複詢問。必要環境無法辨識、權限不足或出現無法安全解決的資料庫差異時，先完成不受影響的工作，再集中回報具體阻礙。

## 2. 工作目錄與目前狀態

| 項目 | 目前資訊 |
| --- | --- |
| 本機 Git repository | `C:\Users\User\Documents\AI\my-stock` |
| Next.js 專案目錄 | `C:\Users\User\Documents\AI\my-stock\stock` |
| 本文件 | `stock/docs/claude-deployment-runbook.md`，相對 Git 根目錄 |
| Railway 設定 | 專案內 `railway.json`、`Dockerfile`、`next.config.ts` |
| 建置與執行 | Node 24 Alpine、`npm ci`、`npm run build`、standalone `server.js` |
| Railway Root Directory | README 記載 `stock/`，須核對線上設定 |
| 部署分支 | 文件建立時本機是 `master`；舊 README 記載 `main`，必須核對 Railway Source 的實際連結 |
| Supabase project ref | 舊任務紀錄為 `trnvkwievjewhghdvniq`，只作查找線索，須與實際連線及 Railway 使用的專案 URL 核對 |
| 本機 Supabase CLI 設定 | 文件建立時沒有 `supabase/config.toml`；優先用已連線的 Supabase MCP 工具，不假設 CLI 已 link |
| 本機修改 | 多個已修改及未追蹤檔案尚未提交；不能只部署目前 HEAD 的舊內容 |

除非另有註明，下文路徑都相對於 Next.js 專案目錄 `stock/`。

功能背景見 [decision-upgrade.md](decision-upgrade.md)。本機已通過 33 項 Node 測試、Next.js production build、三支 EF 的 Deno check，以及 production standalone 桌面／手機免登入讀寫測試。這些結果是本機假資料驗證，仍需核對正式環境。

## 3. 第一步：核對目標與保留回復資料

1. 讀取 `AGENTS.md`、`CLAUDE.md`、本文件與相關 lessons。若需修改 Next.js 程式，先讀取安裝版本的 `node_modules/next/dist/docs/`。
2. 在 Git 根目錄檢查 `git status`、目前分支、remote、upstream 與待部署差異；核對 Railway 服務實際連結的 repository、部署分支、Root Directory 和網站 URL。不要因為 README 寫 main，就直接推送或建立 main。
3. 用已連線的 Supabase 工具列出／辨識專案，確認 project ref、資料庫既有 schema 與 Railway 的 `NEXT_PUBLIC_SUPABASE_URL` 指向同一個目標。若有多個候選而工具無法辨識，這才是需要詢問使用者的必要資訊。
4. 列出正式 migration history、三支 EF 的已部署版本與 JWT 設定，並比對本輪六個 SQL 檔的實際 DDL。線上 view／RPC 可能曾經單獨修改，不可只比檔名就覆蓋。
5. 記錄現有 Supabase 備份／還原點；保存會被替換的 view／RPC 定義、`scan_picks.strategy_version` 原始 default、三支 EF 的完整舊程式及 Railway 舊 deployment／commit，供局部回復。
6. 保存 `check-price-alerts` cron 的 job id、active、schedule 和原始 command。command 可能含憑證，未遮罩備份放在 Git 外的私人位置；報告只記錄備份位置與遮罩摘要，勿輸出密鑰或提交 `.env`、Vault 內容。
7. 記錄基線：最新價格資料日與檔數、掃描筆數、歷史 scan_picks 版本分布、持股交易筆數及待送提醒數。核對 `industry_policy` 等目前線上規則，保留此次更新範圍以外的正式差異。

若既有 schema 和本輪 SQL 有衝突，先查清差異。對未套用 SQL 作必要相容修正時，保存修正檔並補上對應驗證；不刪表、不使用 `CASCADE` 強行通過，不把無關的線上規則改回舊版。

## 4. 第二步：依序套用 Supabase migrations

優先使用 Supabase MCP 的 migration 工具，依實際工具 schema 傳入**檔案完整 SQL**，不要手動重打一份 SQL，也不要只透過一般 SQL 執行工具套用 DDL 而漏掉 migration history。

| 順序 | 完整檔名，位於 `supabase/migrations/` | 主要變更 |
| --- | --- | --- |
| 1 | `20260906000001_scan_adjusted.sql` | 重建還原價格掃描；設定新 scan_picks 版本 default |
| 2 | `20260906000002_scan_track_v2.sql` | 新增共同市場日期的 5／10／20 日前向觀察 view |
| 3 | `20260906000003_trade_plans.sql` | 交易計畫、成交連結及保存／記錄 RPC |
| 4 | `20260906000004_alert_delivery.sql` | 提醒事件重試、可信 cron secret RPC、更新原提醒排程 |
| 5 | `20260906000005_plan_risk.sql` | 現金與持股風險資料、估算快照及原子保存 RPC |
| 6 | `20260906000006_plan_fill_lifecycle.sql` | 刪除誤填成交時同步恢復原計畫的 RPC |

執行規則：

1. 先查 history 和實際物件。這些 SQL 不是全部可重複執行；已成功套用者核對後跳過，不因重跑任務而再次建立欄位／資料表。
2. 每支 migration 以一個交易完整套用，成功後記錄本機檔名、內容雜湊、遠端 migration version 與結果。若 MCP 自動產生版本，明確記錄對應關係；不直接修改 history 假裝一致。
3. 在更新提醒 migration／worker 期間，僅暫停既有 `check-price-alerts` job，記住原 active 狀態，確認執行中的舊 worker 已結束。不要停用其他行情排程。
4. 第四支 migration 要求既有 cron command 包含：`if exists (select 1 from public.alert_rules where enabled) then`。它會保留 HTTP URL／授權內容，新增待送事件判斷，並把排程改為每 10 分鐘可重試；新事件的觸發仍受盤中時間與報價限制。
5. 若該 cron job 不存在、重複或 command 格式不同，先核對正式設定並作最小相容修正，不刪掉檢查直接硬套，不猜 URL 或 JWT。修正必須同時保留在本機待提交檔案中。
6. 任一步驟出錯，先確認該步驟是否已提交交易；不要盲目重試，也不要继续推送網站。保留已成功套用的步驟及可恢復狀態。

只有在 MCP migration 工具不可用，且 CLI 的 link 與歷史已核對時，才改用 CLI：先 `supabase migration list`、`supabase db push --dry-run`，確認待套用範圍正確，再 `supabase db push`。不要加入 `--include-all` 來繞過歷史差異，也不要執行正式資料庫 reset。[Supabase migration 說明](https://supabase.com/docs/guides/deployment/database-migrations)、[CLI 說明](https://supabase.com/docs/reference/cli/supabase-db-push)。

## 5. 第三步：部署三支 Edge Functions

Supabase SQL 就緒後，依序部署下列函式，名稱沿用正式環境，不另建替代名稱。

| Function 名稱 | Entry point | 必須一併包含的本機相依檔案 |
| --- | --- | --- |
| `fetch-yahoo-intraday` | `supabase/functions/fetch-yahoo-intraday/index.ts` | 同目錄 `quote.ts`、`supabase/functions/_shared/authorize.ts` |
| `check-price-alerts` | `supabase/functions/check-price-alerts/index.ts` | `supabase/functions/_shared/authorize.ts` |
| `run-backtest` | `supabase/functions/run-backtest/index.ts` | 同目錄 `execution.ts`、`ledger.ts`、`supabase/functions/_shared/authorize.ts` |

- MCP 部署時依實際工具 schema 指定 entry point、檔案路徑、內容及 JWT 設定，保留相對 import 可解析的目錄結構。只上傳 `index.ts` 會漏掉此次抽出的邏輯。
- 檔案內容透過結構化工具參數傳遞，保留真實換行，避免手工拼接 JSON／shell escape。
- 保持 gateway JWT 驗證，不使用 `--no-verify-jwt`。函式內比對執行環境 service key 或 Vault 的 `edge_function_auth`，可接受兩把不同的可信金鑰；不要退回「只解碼 role」的認證方式。
- 核對 `read_edge_function_auth()`、Telegram 既有讀取 RPC 及所需 secrets 可供服務角色使用，只確認存在／可用，不把值寫進報告。
- 部署後確認各函式的版本／更新時間與 imports 正常，再將提醒 cron 的 active 恢復到部署前狀態，保留新版 command／schedule。原本停用的 job 不要順手啟用。
- 不手動呼叫提醒 worker 作測試，因為它可能投遞真實訊息。透過部署狀態、資料庫權限與既有排程日誌驗證；尚無新排程紀錄時如實標為待觀察。

若使用已核對目標的 CLI，以下是對應部署命令；`--use-api` 使用伺服器端打包，不要求本機 Docker：

```powershell
supabase functions deploy fetch-yahoo-intraday --use-api
supabase functions deploy check-price-alerts --use-api
supabase functions deploy run-backtest --use-api
```

以上命令依賴正確的已 link 專案；未 link 時請以核對後的 project ref 明確指定。不要把此範例當成已完成 link 的證據。[Supabase functions deploy 說明](https://supabase.com/docs/reference/cli/supabase-functions-deploy)。

## 6. 第四步：本機檢查、GitHub 推送與 Railway 部署

若部署前已決定的程式仍需修正，應先完成本節檢查再改正式資料庫；若因正式 schema 相容性修正而變動 SQL／程式，再驗證相應部分。

在 `stock/` 內執行：

```powershell
npm ci
npm test
npm run build
```

若安裝的 lockfile 已一致可沿用依賴；本輪基準是 33 項測試，移除網站登入後不再是 34 項。`npm run build` 包含 TypeScript 檢查。

- 變動 EF 時，另以可用 Deno 執行三支 entry point 的 `deno check --node-modules-dir=none --no-lock`。
- 需要驗證 UI 時，執行 `tests/ui-smoke.mjs`，可設定 `UI_SMOKE_MODE=production`；它使用隔離 HTTP 假資料與 Playwright，會啟動 standalone server。Playwright 及瀏覽器路徑以執行環境為準，不安裝到正式 Railway 容器。
- 本次相關檔案 lint 應無新增 errors；持股 actions 的三個既有 warnings，以及全專案既有 lint 問題需分開記錄，不關閉規則讓結果變綠。

接著執行：

1. 核對 Railway 既有服務設定：GitHub repository／分支、Root Directory `stock/`、Dockerfile builder、standalone 啟動流程。已有正確設定就沿用，不另建服務或變更部署模式。
2. 確認網站原有 `NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 指向剛更新的 Supabase；其他既有變數保留，不新增網站帳密。金鑰只在 Railway Variables／伺服器使用。
3. 檢查 Git diff 與未追蹤檔案，完整納入本輪 UI、`lib/`、持股 action、三支 EF 及其相依檔、六支 migrations、package／lockfile、tests 和相關文件。登入 proxy／access helper 已移除，不能從舊 patch 復原。
4. 僅 stage 本輪相關檔案，檢查 staged diff，再 commit。不要使用無差別 `git add .` 包進私人備份、`.env`、無關修改或其他子專案內容。
5. 推送到已核對的 GitHub 部署分支。若 remote 已前進，先整合必要變動並重新檢查，不 force push、不丟棄使用者修改。
6. 取得 Railway 新 deployment 的結果，核對觸發 commit SHA、build logs、啟動狀態與實際網址。GitHub push 成功不等於 Railway 部署成功；沒有 Railway 讀取能力時，可用已驗證的網站 URL 做 HTTP／瀏覽器檢查，並標示 deployment 狀態仍未能核對。

## 7. 第五步：正式驗證與完成條件

正式資料庫採有範圍的讀取核對；避免對整段歷史做無界限重算。

| 項目 | 必須確認的結果 |
| --- | --- |
| Migration history | 六支更新各有明確成功記錄及檔案對應，重跑不會重複套用 |
| 掃描 | `v_breakout_scan` 可查詢、最新資料日與檔數合理；除權息／籌碼缺料呈現符合新版定義 |
| 前向觀察 | `v_scan_track_v2` 存在；新版樣本尚未累積時可為空，不能把它報成失敗或偽造績效 |
| 舊資料 | 舊凍結樣本不被重標 v3，歷史持股交易和舊回測未被重寫 |
| 交易計畫 | `trade_plans`、`risk_snapshot`、交易表 `plan_id` 與三個保存／成交／刪除相關 RPC 齊備 |
| 風險資料 | `v_plan_risk_context` 可讀；缺設定／估值時不虛構股數，頁面可呈現不可估算的原因 |
| 服務授權 | 新的寫入／secret RPC 僅授予 service_role；anon／authenticated 不可執行 |
| 提醒 | 新投遞欄位、claim RPC、原 job 更新及 active 恢復正確；不漏掉最後規則停用後的 pending queue |
| Edge Functions | 三支已更新且相依檔齊全，部署狀態與後續既有排程日誌無 import／認證錯誤 |
| Railway | 新 deployment 與此次 commit 一致，建置及服務啟動成功 |
| 網站 | `/scan`、`/holdings`、`/backtest` 能開啟，沒有帳密對話框、登入 401 或缺密碼 503 |
| UI | 候選篩選／搜尋、計畫表單及資料狀態正常；讀取失敗不假裝沒有資料 |

注意：計畫相關 RPC 是 `create_breakout_plan`、`create_breakout_plan_with_risk`、`record_plan_buy`、`delete_transaction_with_plan` 共四個；全部都要核對。寫入流程以本機隔離測試確認，不在正式帳戶填入測試買賣單。

可用以下唯讀 SQL 核對物件與權限；結果摘要不包含 secrets：

```sql
select name, to_regclass('public.' || name) as object_id
from (values
  ('v_breakout_scan'), ('v_scan_track_v2'), ('trade_plans'),
  ('v_plan_risk_context'), ('alert_events')
) as objects(name);

select p.oid::regprocedure::text as function_signature,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in (
  'create_breakout_plan', 'create_breakout_plan_with_risk',
  'record_plan_buy', 'delete_transaction_with_plan',
  'claim_price_alerts', 'read_edge_function_auth'
);

select jobid, jobname, schedule, active
from cron.job where jobname = 'check-price-alerts';
```

回測仍是多因子排名，起漲掃描交易績效尚未驗證。若本次沒有執行真實行情回測，就明寫未執行；不為部署啟動大量研究工作。查看既有新版回測時，核對 `daily-stop-v4`／`daily-cash-ledger-v1`、每日日期長度及資產等於現金加持股；舊回測仍可使用舊版本。

## 8. 失敗時的處理與回復

- **Migration 失敗**：停止後續更新與 GitHub 推送，確認交易有無回滾，記錄已成功步驟。修正後只續跑未完成部分，不重跑整包 SQL。
- **EF 更新失敗**：以備份的完整檔案及原設定還原失敗函式，核對與目前資料庫是否相容。提醒 worker 不能安全運作時暫留該 job 停用，明確回報狀態，其他 job 不變。
- **網站部署失敗**：保留／恢復 Railway 前一個成功 deployment，或以正常 revert commit 觸發重新部署。不要 reset／force push 改寫 Git 歷史。
- **需回復資料庫邏輯**：依保存定義恢复原掃描 view 與 scan_picks default；保留新計畫、risk_snapshot、plan_id、提醒事件及歷史資料。需要再改正式 DDL 時，新增可追蹤的修復 migration，不刪除成功的 migration history。
- **提醒回復**：先盤點未送達事件，再決定恢復原 cron command／schedule／active。舊 worker 不讀新 pending queue，不能假設回退就會自動送完，也不自行批量重送。

## 9. Claude 最終回報格式

請以繁體中文提供簡短報告，必要證據寫入新建的 `docs/deployment-result-YYYYMMDD-HHmm.md`，不覆寫本執行手冊，也不把密鑰或含密鑰的原始 command 寫入報告。

1. 實際 Supabase project ref、六支 migration 的本機檔名／遠端 version／結果。
2. 三支 EF 的版本／結果，提醒 cron 的更新與恢復狀態。
3. GitHub repository／部署分支／commit SHA。
4. Railway deployment id／結果／網站 URL；哪些項目由工具核對、哪些僅由 HTTP 驗證。
5. 測試與正式抽查結果；未驗證事項及具體原因。
6. 是否全部完成；若部分完成，列出已完成、待完成、回復狀態和使用者唯一必要的下一步。

部署結果報告可先留在本機；不要只為提交結果報告而再次推送、觸發第二次 Railway 部署。

## 10. 可直接貼給 Claude 的提示詞

```text
請讀取並依序執行這份部署文件：
C:\Users\User\Documents\AI\my-stock\stock\docs\claude-deployment-runbook.md

請使用你已連線的 Supabase 工具完成本輪 migrations、三支 Edge Functions、必要的相容修正與驗證，再提交並推送本輪相關程式到已核對的 GitHub 部署分支，觸發既有 Railway 部署，確認部署結果與網站可用性。這段指示已授權上述部署操作，請直接完成，不要只回覆計畫或逐步重複詢問。

網站只有我使用，不要新增帳號密碼或登入限制。保留既有資料、服務金鑰與 Edge Function 服務授權。先核對真正的 Supabase 專案和 Railway 部署分支；本機 master 與舊文件 main 有差異，不要猜測。不要提交 secrets，不要建立虛構持股交易，也不要額外發送 Telegram 測試訊息。

只有當工具權限不足、目標無法核對或遇到無法安全解決的部署差異時，才集中告知需要我提供的最少資訊。最後依文件回報實際 migration／函式版本、commit、Railway 狀態、網址與驗證結果；未完成的部分要明確列出。
```
