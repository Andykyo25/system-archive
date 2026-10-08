# broker-sync

唯讀地把富邦證券的庫存快照寫進 Supabase,與 `holdings_transactions` 對帳。Railway cron 平日 Taipei 18:00 跑一次(`railway.json`:UTC `0 10 * * 1-5`)。

- 只呼叫 `sdk.accounting.*`;**不下單、不寫 `holdings_transactions`**
- 主線(失敗 = 整次失敗):`inventories`、`unrealizedGainsAndLoses` → `broker_inventory_snapshot` / `broker_snapshot_run` → view `v_broker_recon`(migration `20261006000001`)
- 附加(失敗不阻止庫存快照寫入,但整次 `success=false`(`partial: …`)、exit 1,/health 會亮;migration `20261007000001` + `20261007000002`):

  | 查詢 | 表 | 語意 |
  |------|----|------|
  | `querySettlement(acct, '3d')` | `broker_settlement` | 以 `(account_no, query_date)` 為鍵,新抓到的覆蓋舊的(每天回近三天,不會重複);無交易日金額為 null |
  | `realizedGainsAndLoses` | `broker_realized_snapshot` | 券商現況鏡像,RPC `replace_broker_realized` **整表取代**(API 沒有日期參數,窗口多長首跑才知道);查詢不完整時**不取代**。你自己的交易紀錄才是帳本 |

- **不查 `bankRemain`**:官方限定交割銀行為台北富邦銀行 / LINE Bank,Andy 的帳戶不是

- 每次執行寫一筆 `fetch_log`(`source='broker-sync'`),自動出現在 `/health`
- SDK 來自富邦官方網址、以 sha256 鎖版(見 `Dockerfile`);**不要**改用 npm 上的 `fubon-neo`(第三方上傳)

## Railway service 設定

同一個 project 新增 service:Root Directory = `stock/workers/broker-sync`,Builder = Dockerfile。Cron 排程若沒有從 `railway.json` 帶入,到 Settings → Cron Schedule 填 `0 10 * * 1-5`(UTC)。

| 環境變數 | 說明 |
|----------|------|
| `FUBON_ID` | 身分證字號 |
| `FUBON_API_KEY` | **只開「證券業務」權限**的 API Key,不要放含「證券下單」的 key |
| `FUBON_CERT_B64` | `.pfx` 憑證的 base64(PowerShell:`[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\CAFubon\<ID>\<ID>.pfx"))`) |
| `FUBON_CERT_PASSWORD` | 憑證密碼;不設則 SDK 預設用身分證字號 |
| `SUPABASE_URL` | 同 web service |
| `SUPABASE_SERVICE_ROLE_KEY` | 同 web service |
| `DRY_RUN` | 預設開(只登入 + 查詢 + 記 `fetch_log`,不寫快照);確認無誤後設 `0` |
| `ALLOW_EMPTY` | 設 `1` 才允許「券商回空、系統卻有持股」時照寫(預設視為失敗) |
| `JOBS` | 背景工作清單(逗號分隔,目前有 `etf`、`tdcc`);不設 = 全部,設成空字串 = 全部停用 |
| `JOB_BUDGET_SEC` | 背景工作的時間預算,預設 `420`;預算用完就停,下次接著做 |
| `HARD_KILL_SEC` | 整個程序的硬砍秒數(Dockerfile),預設 `600`;要比 `JOB_BUDGET_SEC` + 約 30 秒大 |

這些值只放 Railway 環境變數,不要進 repo、不要貼進對話。

## 背景工作(jobs)

每日同步**結案之後**才執行(`jobs.mjs`),用有時間預算的方式逐步補富邦**行情** API 的資料。失敗、逾時、被限流都只影響它自己:有獨立的 `fetch_log`(`source='broker-jobs'`),不影響庫存同步與它的 exit code。DRY_RUN 時不執行。

| 工作 | 內容 | 寫入 | 頻率 |
|------|------|------|------|
| `etf` | 主動式 ETF(`etf_metadata.is_active_etf` 且代號 `^[0-9]{5}A# broker-sync

唯讀地把富邦證券的庫存快照寫進 Supabase,與 `holdings_transactions` 對帳。Railway cron 平日 Taipei 18:00 跑一次(`railway.json`:UTC `0 10 * * 1-5`)。

- 只呼叫 `sdk.accounting.*`;**不下單、不寫 `holdings_transactions`**
- 主線(失敗 = 整次失敗):`inventories`、`unrealizedGainsAndLoses` → `broker_inventory_snapshot` / `broker_snapshot_run` → view `v_broker_recon`(migration `20261006000001`)
- 附加(失敗不阻止庫存快照寫入,但整次 `success=false`(`partial: …`)、exit 1,/health 會亮;migration `20261007000001` + `20261007000002`):

  | 查詢 | 表 | 語意 |
  |------|----|------|
  | `querySettlement(acct, '3d')` | `broker_settlement` | 以 `(account_no, query_date)` 為鍵,新抓到的覆蓋舊的(每天回近三天,不會重複);無交易日金額為 null |
  | `realizedGainsAndLoses` | `broker_realized_snapshot` | 券商現況鏡像,RPC `replace_broker_realized` **整表取代**(API 沒有日期參數,窗口多長首跑才知道);查詢不完整時**不取代**。你自己的交易紀錄才是帳本 |

- **不查 `bankRemain`**:官方限定交割銀行為台北富邦銀行 / LINE Bank,Andy 的帳戶不是

- 每次執行寫一筆 `fetch_log`(`source='broker-sync'`),自動出現在 `/health`
- SDK 來自富邦官方網址、以 sha256 鎖版(見 `Dockerfile`);**不要**改用 npm 上的 `fubon-neo`(第三方上傳)

## Railway service 設定

同一個 project 新增 service:Root Directory = `stock/workers/broker-sync`,Builder = Dockerfile。Cron 排程若沒有從 `railway.json` 帶入,到 Settings → Cron Schedule 填 `0 10 * * 1-5`(UTC)。

| 環境變數 | 說明 |
|----------|------|
| `FUBON_ID` | 身分證字號 |
| `FUBON_API_KEY` | **只開「證券業務」權限**的 API Key,不要放含「證券下單」的 key |
| `FUBON_CERT_B64` | `.pfx` 憑證的 base64(PowerShell:`[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\CAFubon\<ID>\<ID>.pfx"))`) |
| `FUBON_CERT_PASSWORD` | 憑證密碼;不設則 SDK 預設用身分證字號 |
| `SUPABASE_URL` | 同 web service |
| `SUPABASE_SERVICE_ROLE_KEY` | 同 web service |
| `DRY_RUN` | 預設開(只登入 + 查詢 + 記 `fetch_log`,不寫快照);確認無誤後設 `0` |
| `ALLOW_EMPTY` | 設 `1` 才允許「券商回空、系統卻有持股」時照寫(預設視為失敗) |
| `JOBS` | 背景工作清單(逗號分隔,目前有 `etf`、`tdcc`);不設 = 全部,設成空字串 = 全部停用 |
| `JOB_BUDGET_SEC` | 背景工作的時間預算,預設 `420`;預算用完就停,下次接著做 |
| `HARD_KILL_SEC` | 整個程序的硬砍秒數(Dockerfile),預設 `600`;要比 `JOB_BUDGET_SEC` + 約 30 秒大 |

這些值只放 Railway 環境變數,不要進 repo、不要貼進對話。
)每日持股;自己做前後日差分,整檔被賣出補一列 `quantity=0` | `etf_holdings_daily` → `v_etf_active_flow` | 每檔每天;首次回填自 2025-01-01 |
| `tdcc` | 集保戶股權分散,只存衍生值(千張 / 400 張以上大戶、≤50 張散戶的人數與持股比、總人數) | `tdcc_distribution_weekly` → `v_tdcc_latest` | 宇宙(`stock_universe` ∪ 曾交易)每檔每 3 天;首次抓近 1 年 |

- 進度表 `broker_job_task(job, task_key)`:任務清單是確定性的,跑完才記;失敗記 `-1`、3 天內不重試;被限流(429)不記失敗
- 速率:全域相隔 ≥ 1.1 秒(歷史行情 60 次 / 分);429 等 65 秒重試一次,再 429 就停止本次所有工作
- 首次成功後自動登錄 `data_source_expectation`(`broker-jobs`,5 天)
- 這些是**看盤資訊**(顯示在 `/stocks/[symbol]` 的「集保與 ETF」),不是訊號:籌碼指標的預測力尚未經本系統 PIT 驗證(M10)
- 停用:Railway 設 `JOBS=`(空值);rollback 見 `tasks/todo.md`

## 驗證

1. DRY_RUN 首跑後查:`select started_at, success, rows_skipped, error from fetch_log where source='broker-sync' order by id desc limit 3;`
   成功時 `error` 會是 `DRY_RUN ok: {...}`(只有欄位名與筆數);失敗時 `error` 是原因。
   DRY_RUN 診斷會列出兩個附加查詢的實際欄位名(`settlement_fields` / `realized_fields`),與官方文件逐一核對;`warnings` 為空才算全過。
2. 設 `DRY_RUN=0` 再跑一次,然後 `select * from v_broker_recon order by symbol;`
   附加表:`select * from broker_settlement order by query_date desc;` / `select * from broker_realized_snapshot order by data_date desc;`

## 回滾

刪掉 Railway service → 撤銷該 API Key → `drop view v_broker_recon; drop function replace_broker_snapshot(date, jsonb); drop table broker_inventory_snapshot; drop table broker_snapshot_run;`

只退掉附加查詢:git revert 該次 commit,再 `drop function replace_broker_realized(date, jsonb); drop table broker_realized_snapshot; drop table broker_settlement;`
