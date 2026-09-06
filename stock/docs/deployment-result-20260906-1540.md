# 部署結果報告：起漲決策與 UI 更新

執行時間：2026-09-06 15:00–15:40（Taipei，UTC 07:00–07:40）
依據：`docs/claude-deployment-runbook.md`

---

## Executive Summary

**本輪部署全部完成。** 六支 migrations、三支 Edge Functions、GitHub push、Railway build 與網站可用性都已實際核對通過，既有資料（385 筆 scan_picks、41 筆持股交易、76 筆舊回測、9608 筆回測明細）完全未被改寫或重標。

**唯一未能執行的項目是本機測試套件**：這台機器沒有安裝 Node.js / npm / Deno / Supabase CLI，因此 `npm ci`、`npm test`（33 項）、`npm run build`、`deno check`、`tests/ui-smoke.mjs` 都無法在本機重跑。TypeScript 與建置正確性改由 Railway 容器內的 `npm ci` + `npm run build`（含 TS 檢查）實際建置成功來背書，並以線上頁面實測補強。詳見第 5 節。

---

## 1. Supabase migrations

**實際 project ref：`trnvkwievjewhghdvniq`**（名稱 `predictions`，region ap-northeast-1，ACTIVE_HEALTHY）

核對方式：帳號下只有兩個專案（另一個是無關的 `travel record`），且 `predictions` 的既有 schema 與本輪 SQL 依賴的物件（`price_daily.adj_factor`、`stock_industry`、`industry_policy`、`holdings_transactions`、`day_trades`、`app_settings`、`v_latest_price_realtime`）全數吻合，與舊任務紀錄的線索一致。

套用前最後一支 migration：`20260828124338_capital_incomplete_use_rounded_cash`；六支新 migration 皆為首次套用（無重複套用風險）。

| # | 本機檔名 | 檔案 SHA-256（前 16） | 遠端 version | 結果 |
| --- | --- | --- | --- | --- |
| 1 | `20260906000001_scan_adjusted.sql` | `d65196b9264f7ec2` | `20260906072500` `scan_adjusted` | 成功 |
| 2 | `20260906000002_scan_track_v2.sql` | `676df588e41977a3` | `20260906072521` `scan_track_v2` | 成功 |
| 3 | `20260906000003_trade_plans.sql` | `775f0144fc7d997f` | `20260906072545` `trade_plans` | 成功 |
| 4 | `20260906000004_alert_delivery.sql` | `ca273eecff59d8f8` | `20260906072609` `alert_delivery` | 成功 |
| 5 | `20260906000005_plan_risk.sql` | `36d4a677aa071d3b` | `20260906072629` `plan_risk` | 成功 |
| 6 | `20260906000006_plan_fill_lifecycle.sql` | `3fa9e260293980a0` | `20260906072639` `plan_fill_lifecycle` | 成功 |

遠端 version 由 MCP migration 工具自動產生（UTC 時戳），與本機檔名序號一一對應如上表。每支都是單一交易完整套用，未修改既有 history。

**未作任何相容性修正**：六支 SQL 都以原文套用，沒有改動任何一行。事前逐一比對過線上 schema，沒有發現衝突。

## 2. Edge Functions

三支都以「函式目錄 + `_shared/`」的結構上傳，保留相對 import 可解析；`verify_jwt` 全部維持 `true`，未使用 `--no-verify-jwt`。

| Function | 舊版本 | 新版本 | 一併上傳的相依檔 | 結果 |
| --- | --- | --- | --- | --- |
| `check-price-alerts` | v1 | **v2** | `_shared/authorize.ts` | 成功 |
| `fetch-yahoo-intraday` | v7 | **v8** | `quote.ts`、`_shared/authorize.ts` | 成功 |
| `run-backtest` | v7 | **v8** | `execution.ts`、`ledger.ts`、`_shared/authorize.ts` | 成功 |

其餘 20 支 EF 完全未動（版本與 updated_at 皆不變）。

`run-backtest/index.ts` 有 29.4 KB，透過工具參數傳遞前先把內容寫成暫存檔與原始檔 `diff`，確認 SHA-256 相同（`e8493181b63cb11c…`）後才部署，避免手工轉錄誤差。

**服務授權核對（只確認存在／可用，未輸出任何值）**
- `read_edge_function_auth()` 可由 service_role 執行且回傳非 null → Vault 的 `edge_function_auth` 存在。
- `read_telegram_bot_token` / `read_telegram_chat_id` 兩支 RPC 都在。
- 新版認證邏輯是「比對執行環境 service key 或 Vault cron secret」，兩把可信金鑰皆接受；已不再是舊版的「只解碼 JWT role」。

## 3. 提醒 cron（jobid 25 `check-price-alerts`）

| 項目 | 部署前 | 部署後 |
| --- | --- | --- |
| active | `true` | **`true`（已還原）** |
| schedule | `*/10 1-5 * * 1-5` | `*/10 * * * *` |
| command 長度 | 538 | 701 |

- 更新期間先將 job 暫停（`active := false`），三支 EF 部署完成後還原為原本的 `true`。其他排程一律未動。
- migration 4 的守門檢查通過：舊 command 恰好包含一次 `if exists (select 1 from public.alert_rules where enabled) then`。
- 更新後確認 command 仍保留原 HTTP URL（`functions/v1/check-price-alerts`）與原授權來源（執行時從 Vault 讀 `edge_function_auth`），只新增了「有待送事件也要跑」的判斷。command 本身不含明文金鑰。
- 排程改為每 10 分鐘全日可重試；新事件仍受 `claim_price_alerts` 內的盤中時間與報價來源限制。
- 部署前後 `alert_rules` enabled = 0、未送達 `alert_events` = 0，沒有遺漏的 pending queue。

## 4. GitHub 與 Railway

**分支核對結果（重要）**：`origin/main` 與本機 `master` 在部署前指向**同一個 commit**（`b9fd311`），`origin/HEAD` 也指向 `main`；而 `origin/master` 停在很舊的 `1aea470`。因此實際部署分支是 **`main`**，本機 `master` 只是本地分支名不同。已用 GitHub commit status 驗證 Railway 確實掛在這個分支上。

- Repository：`Andykyo25/system-archive`
- 部署分支：**`main`**
- Commit：**`48103c5`** — `feat(stock): 起漲決策閉環 — 還原價掃描 + 交易計畫/風險 + 提醒重試投遞`
- Push：`b9fd311..48103c5 master -> main`（fast-forward，未 force push；push 前重新 fetch 確認 remote 未前進）
- 納入 43 個檔案（+4322 / −1046）：UI、`lib/`、持股 action、三支 EF 及相依檔、六支 migrations、package/lockfile、`tests/`、`docs/`
- 只 stage 本輪相關路徑（未用 `git add .`）；staged diff 已掃過 JWT／service key／bot token／密碼等樣式，**無 secrets，無 `.env`，無硬編 Supabase URL**

**Railway**
- Project `7345c927-5d24-478e-a101-c87740c5ff04` / Service `04dc587a-1933-413a-b96a-8207364a75dc`（`optimistic-energy - system-archive`）/ Environment `c537d127-1dc5-4737-a58a-0462bb34f767`
- **Deployment id `025c5e08-d444-4b7b-be6e-a2e881afbb71`**
- 結果：**成功** — `Success - system-archive-production.up.railway.app`
- 觸發 commit：`48103c5`（與本次 push 一致）
- 網址：**https://system-archive-production.up.railway.app**
- 沿用既有服務設定與環境變數，未新建服務、未改部署模式、未新增任何帳密或存取變數

**核對來源分工（誠實標示）**
- 由工具直接核對：Supabase 全部項目（MCP）、Git 全部項目（本機 git）、網站頁面（HTTP）
- 由 GitHub commit status API 間接核對：Railway 的 build/deploy 結果與 deployment id、網址。**本機沒有 Railway API token／CLI／MCP**，所以 build log 逐行內容未讀取；不過該 status 是 Railway 自己回報的，且已用實際 HTTP 請求確認新版網站可用。

## 5. 驗證結果

### 5.1 Supabase 正式抽查（全部通過）

| 項目 | 結果 |
| --- | --- |
| Migration history | 六支各有獨立 version 記錄，重跑不會重複套用 |
| `v_breakout_scan` | 可查詢，1134 檔，資料日 2026-09-04，`passes_all` 1 檔 |
| 籌碼缺料呈現 | 985/1134 檔 `fgn_net_5d` 為 null — 新版「逐檔要求共同 5 個市場交易日」的預期結果，缺料誠實顯示為缺料 |
| `v_scan_track_v2` | 存在可查，1155 列 |
| 舊資料未被重標 | `scan_picks` 385 筆，`strategy_version` **全部仍為 null**；default `'breakout-v3-adjusted'` 只對新資料生效 |
| 舊回測未被改寫 | `backtest_runs` 76 筆、`backtest_trades` 9608 筆不變；使用新帳務版本的 run = 0；最新 run 起始時間仍是 2026-07-17 |
| 歷史持股交易 | 41 筆不變，`plan_id` 全為 null |
| 交易計畫 | `trade_plans`（RLS 已啟用）、`risk_snapshot` 欄位、`holdings_transactions.plan_id` 齊備；`trade_plans` 0 筆（未建立任何虛構資料） |
| 風險資料 | `v_plan_risk_context` 可讀，`coverage_ok = true`，price_date 2026-09-04，1 檔持股 |
| 提醒欄位 | `alert_events` 新增 4 個 delivery 欄位 |
| 服務授權 | `create_breakout_plan` / `create_breakout_plan_with_risk` / `record_plan_buy` / `delete_transaction_with_plan` / `claim_price_alerts` / `read_edge_function_auth` **六支全部 anon=false、authenticated=false、service_role=true**；`trade_plans`、`v_plan_risk_context`、`v_scan_track_v2` 對 anon／authenticated 均無權限 |

### 5.2 網站實測（HTTP，2026-09-06 15:38 後）

| 路徑 | HTTP | 檢查 |
| --- | --- | --- |
| `/` | 200 | 正常 |
| `/scan` | 200 | 318 KB，出現「起漲／掃描／候選／交易計畫」與資料日 `2026-09-04`；停損欄位 105 處、籌碼 35 處、評分 25 處、缺料 5 處 |
| `/holdings` | 200 | 241 KB，正常渲染 |
| `/backtest` | 200 | 219 KB，正常渲染 |
| `/backtest/compare` | 200 | 正常 |
| `/backtest/2b38dc97…`（舊版本 run） | 200 | 385 KB，正確顯示舊 run 名稱與勝率／最大回撤／月報酬 |
| `/settings` | 200 | 正常 |

全部頁面**沒有帳密對話框、沒有 401、沒有 `WWW-Authenticate` 挑戰、沒有缺密碼 503**，也沒有 Application error／讀取失敗等錯誤字樣。

### 5.3 未執行／待觀察項目（含原因）

1. **本機測試與建置未執行** — 這台機器沒有 Node.js、npm、Deno、Supabase CLI（已確認不在 PATH，也不在 WinGet／Program Files／使用者目錄；README 記載的 WinGet node 路徑在這台機器上不存在，該目錄只有 FFmpeg）。因此 `npm ci`、`npm test`（33 項）、`npm run build`、三支 EF 的 `deno check`、`tests/ui-smoke.mjs`、lint 都**無法在本機重跑**。
   - 補償驗證：Railway 容器內實際跑了 `npm ci` + `npm run build`（Next.js build 含 TypeScript 檢查）並**建置成功**，等同於通過一次完整型別與建置檢查；且線上七個頁面實測正常。
   - 事前另以靜態方式核對：`package.json` 新增的 `@electric-sql/pglite` 已同步寫入 `package-lock.json`（否則 `npm ci` 會失敗）；新增／變更檔案的所有 import 目標與具名匯出都存在。
   - 仍未覆蓋：33 項單元測試的實際斷言結果、UI smoke 的互動流程、lint 新增 warning 數。
2. **提醒 worker 未實際觸發** — 依指示未手動呼叫 worker、未發送任何 Telegram 測試訊息。新排程（每 10 分鐘）在報告產出時尚無執行紀錄，狀態為**待觀察**；下次排程執行後可在 `fetch_log`（source = `check_price_alerts`）查看。目前 enabled 規則為 0，worker 會直接回 `claimed: 0`。
3. **`v_scan_track_v2` 尚無 settled 樣本** — 1155 列全部是 `pending`，因為新版前向觀察需要 scan_date 之後累積足夠交易日。這是預期狀態，**不是失敗，也沒有偽造績效**。
4. **本輪未執行真實行情回測** — 起漲掃描的交易績效仍未驗證。`daily-stop-v4` / `daily-cash-ledger-v1` 目前有 0 筆 run（新 EF 剛部署），既有 76 筆舊回測維持舊版本口徑可用。
5. **Railway build log 未逐行讀取** — 無 Railway 讀取權限，僅取得成功／失敗結論與 deployment id。

## 6. 完成度與回復狀態

**結論：本輪部署項目全部完成，無需回滾。**

已完成：六支 migrations、三支 EF、cron 更新與 active 還原、GitHub commit + push、Railway build/deploy 成功、Supabase 抽查與網站實測。

未完成（僅一項，且非部署阻礙）：本機測試套件與 lint，原因是環境缺 Node.js（見 5.3-1）。

**備份與回復資料位置**：`C:\Users\User\Documents\AI\deploy-backups-20260906\`（Git 外的私人位置）
- `BASELINE.md` — 部署前基線與遮罩後的 cron 摘要（不含任何金鑰）
- `ROLLBACK_v_breakout_scan.sql` — 還原舊掃描 view 用
- `ef-git-head/*.ts` — 三支 EF 的舊版原始碼（等同 commit `b9fd311`）

回復手段（目前不需要執行）：
- 掃描 view → 套用 `ROLLBACK_v_breakout_scan.sql`
- `scan_picks` default → `alter table public.scan_picks alter column strategy_version drop default;`
- EF → 由 `ef-git-head/*.ts` 或 `git show b9fd311:stock/supabase/functions/<name>/index.ts` 重新部署
- 網站 → 以正常 revert commit 觸發重新部署（不 reset／force push）
- cron → schedule 還原為 `*/10 1-5 * * 1-5`、gate 還原為舊字串

**使用者唯一必要的下一步（非阻礙，可擇期）**：若要補齊本機測試證據，在有 Node.js 24 的環境執行 `npm ci && npm test && npm run build`。線上服務目前運作正常，不做這件事也不影響使用。

（本報告未提交，也未因此再次觸發 Railway 部署。）
