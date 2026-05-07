# 持股分析系統 — Milestone 與 Todo

> 工作流程依 [CLAUDE.md](../CLAUDE.md)。每個項目完成後勾選並寫 1~2 行 review。

---

## 已拍板的核心決策(2026-05-07)

- **前端**:Next.js 14+(App Router)+ TypeScript
- **Auth**:**完全不做**。只有 Andy 自己用。Supabase 用 `SUPABASE_URL` + `SUPABASE_ANON_KEY`(前端)+ `SUPABASE_SERVICE_ROLE_KEY`(後端);無 admin 路由,所有功能用 tab 區分嵌在主 UI;`robots.txt` 擋爬蟲
- **Repo**:沿用 `system-archive`,本專案在 `stock/` 子目錄
- **部署**:Railway,root directory 設 `stock/`,Dockerfile builder + Node 22
- **資料源**:主力 = TWSE/TPEX 官方收盤 OpenAPI;備案 = FinMind 免費版
- **排程**:pg_cron(Supabase 內建)
- **範圍**:`holdings` + `watchlist`(< 30 檔)+ paper trading(模擬下單)

---

## M0 — 專案骨架(0.5 day)`analyst-deployer`

- [x] 在 `stock/` 下初始化 Next.js 16 App Router + TypeScript + Tailwind v4(Turbopack)
- [x] `package.json` / `tsconfig.json` / `eslint.config.mjs` / `.gitignore` / `.env.example`
- [x] `public/robots.txt`(Disallow: / 擋搜尋引擎)
- [x] 寫 `Dockerfile`(Node 24-alpine,Next.js standalone multi-stage build,non-root user)
- [x] 寫 `railway.json`(builder = Dockerfile,Restart on failure)
- [x] `.env.example` 列必要 env(`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `FINMIND_TOKEN`)
- [x] `npm run build` 成功(standalone server.js + .next/static 產出正常)
- [x] commit & push 到 `main`(commit `5714c78`,Andy push)
- [x] Railway 已配置完成(Andy 自行設定)

**Review**:
- 框架實際版本:Next.js **16.2.5** + React **19.2.4** + Tailwind **v4**(注意 v4 PostCSS plugin 改用 `@tailwindcss/postcss`,跟 v3 寫法不同)
- Node 本機 24.15(winget LTS 已升 24);Dockerfile `ARG NODE_VERSION=24`,`engines.node: ">=22"` 寬鬆相容
- create-next-app 自動產出 `AGENTS.md`(Next.js 16 breaking changes 警示),保留並從 `CLAUDE.md` 用 `@AGENTS.md` 引用
- Auth 簡化掉,單頁 tab UI,`robots.txt` 擋搜尋引擎

---

## M1 — 資料層 schema(0.5 day)`data-pipeline`

實際合併成 5 個邏輯 migration,全部都在 `stock/supabase/migrations/` 並透過 Supabase MCP apply 到 project `trnvkwievjewhghdvniq`。

- [x] **001_core_tables**:`holdings` / `watchlist` / `paper_orders`(使用者直接維護的資料)
- [x] **002_price_data**:`price_daily`(PK = symbol + trade_date 做 lock)+ `price_intraday_cache`
- [x] **003_pipeline_ops**:`fetch_log` / `api_quota_state` / `reconcile_audit`
- [x] **004_alerts**:`alert_rules` + `alert_events`(FK → alert_rules,delete cascade)
- [x] **005_rls**:全部 10 表 enable RLS(實際發現 Supabase 平台有 `rls_auto_enable()` event trigger 已自動做這件事,migration 為冗餘但 idempotent)
- [x] 走 service_role 全寫(無 client-side 寫),所以 `rls_enabled_no_policy` advisor INFO 是預期內,不加 policy

**Review**:
- 10 表全部建好,RLS 全 on,row count = 0
- 索引覆蓋:`price_daily.trade_date`、`alert_events` 未發送、`paper_orders` symbol+time、`holdings` 持有中(closed_at is null)
- Schema 設計關鍵:**`price_daily` PK = (symbol, trade_date)** 強制每組唯一性,主力寫入後 `INSERT ... ON CONFLICT DO NOTHING` 即達成 lock(M2 會用)
- `is_provisional` 配 partial index `where is_provisional = true` 加速 reconcile 查詢
- Supabase advisor:1 個 SECURITY DEFINER 警告是 `rls_auto_enable()`(平台內建,event trigger function,anon 直呼叫等於 no-op),不需處理
- Migration 名稱用 `YYYYMMDDHHMMSS_<name>.sql` 對齊 Supabase CLI 慣例,之後 `supabase db push` 可重建

---

## M2 — 主力資料源接入(1 day)`data-pipeline`

實際合併 TWSE + TPEX 進同一個 Edge Function,因為兩家欄位差異不大且兩者一起跑/一起記 log 比較好維運。

- [x] 研究 TWSE / TPEX 官方收盤 OpenAPI:免註冊免限速,Date 是民國年 7 碼字串
- [x] Edge Function `fetch-daily-prices`:同時抓 TWSE + TPEX,filter 到 `holdings.symbol ∪ watchlist.symbol`
- [x] 寫入用 `upsert(... ignoreDuplicates: true)` = `ON CONFLICT DO NOTHING` 實作 lock
- [x] 啟用 `pg_cron` + `pg_net` extensions(migration 006)
- [x] 排程 `cron.schedule('fetch-daily-prices', '30 6 * * 1-5', ...)` = 平日 14:30 Taipei(migration 007)
- [x] JWT 用 vault secret `edge_function_auth` 存取,migration 不洩漏 JWT
- [x] 端到端驗證:手動 curl 200 OK / 寫 1 筆;net.http_post 200 OK / lock skip 正確;cron 排程已 active
- [ ] 等隔週 5 個交易日後檢查連跑穩定性(由 cron 自動執行,觀察 `fetch_log` 與 `price_daily` 累積)

**Review**:
- 一次 fetch:TWSE 1350 檔(含 ETF),TPEX 5743 筆(含權證等)
- TSMC 2330 抓回:close 2250(2026-05-06),數字與 TWSE 網站一致 ✅
- Lock 機制驗證:同檔同日連跑 3 次,只第一次 written=1,後續 written=0 / skipped=1 ✅
- TPEX endpoint 偶發 "error reading a body from connection"(payload ~5MB 大,可能網路毛邊),已 lessons L06 記錄
- Edge Function auth 用 JWT payload role 檢查,而不是與 `SUPABASE_SERVICE_ROLE_KEY` env 比對(已 lessons L05 記錄)
- 測試資料(2330 watchlist 與 price_daily)已清除,DB 回空狀態

---

## M3 — 備案資料源 + Reconciliation(0.5 day)`data-pipeline`

- [x] FinMind 免費版 token(Andy 提供),存入 Supabase **vault** `finmind_token`
- [x] RPC `public.read_finmind_token()`(SECURITY DEFINER,只 service_role 能呼叫)— Edge Function 用這個讀 vault,免設環境變數
- [x] Edge Function `fetch-finmind-fallback`:fill 主力空缺(client-side 過濾 existingKeys + `ON CONFLICT DO NOTHING`),寫入 `is_provisional=true`
- [x] Quota 機制:`api_quota_state` 記 finmind/today,每次扣減,跑滿停手
- [x] pg_cron:平日 16:00 Taipei (UTC 08:00),已 active(jobid=2)
- [ ] ~~Edge Function `reconcile-provisional`~~ — **改為「first-write-wins」,不做 reconcile**(見下面 review 解釋)
- [ ] ~~pg_cron 每日 22:00 reconcile~~ — 同上
- [ ] 等實際運作幾天看 fallback / quota 行為(由 cron 自動跑,無動作)

**Review**:
- 端到端驗證:第 1 次跑 written=5(2330 過去 7 個交易日,close 數字與 FinMind 一致)、第 2 次跑 written=0/skipped=5(lock 工作)
- FinMind 欄位特殊:`max`/`min`(不是 high/low)、`stock_id`(不是 code)— 已在 `parseFinmind` 處理,L09 lessons 記錄
- Vault + RPC 模式:**Edge Function 不需設置環境變數 secret**,所有 secret 走 vault + SECURITY DEFINER RPC,migration history 不洩漏 token
- Quota 600/day 為 FinMind 免費保守值,30 symbol × 1 call/day = 30 call,還有大量餘裕
- **跳過 reconcile 的設計決策**:
  - 原計畫:fallback 寫的 provisional 在主力恢復後被覆寫
  - 問題:TWSE STOCK_DAY_ALL 只給「今天」,沒辦法用同一個 endpoint 回頭抓昨天的歷史去覆蓋 provisional
  - 取捨:**first-write-wins**,任何已寫入的 row 永不被覆寫(跨 source 也不)— 完全符合 Andy「不能因為切換 API 導致股價跳來跳去」的硬約束
  - 副作用:若 fallback 比主力先寫(例如主力今天 15:00 才恢復、fallback 16:00 已寫過),今天的 row 永遠是 provisional;UI 會顯示來源警示
  - 真正需要 reconcile 時再加 M3.5(用 TWSE STOCK_DAY 單股歷史 endpoint 補蓋)

---

## M4 — 分析層(1 day)`analyst-deployer`

- [ ] SQL view `v_holdings_pnl`:每檔現價、未實現損益、權重
- [ ] SQL view `v_portfolio_summary`:總成本、總市值、總損益
- [ ] SQL view `v_paper_positions`:模擬部位累計(把 `paper_orders` 加總 → 當前持股)
- [ ] SQL view `v_paper_pnl`:模擬部位用最新 `price_daily.close` 算損益
- [ ] 技術指標(後端 RPC 或 SQL function):MA20 / MA60 / RSI14 / KD
- [ ] 警示檢查:每日盤後 1 次 batch 跑,觸發的寫進 `alert_events`(暫不串通知)

**Review**:_(完成後填)_

---

## M5 — Web UI(1.5~2 day)`analyst-deployer`

單頁 tab 結構,無 admin 路由分離。所有 CRUD 直接嵌在主 UI。

### Tab 結構
- [ ] **Tab 1 — Dashboard**:真實持股總覽 + 損益 + 權重圓餅 + 「真實 vs 模擬」對照卡
- [ ] **Tab 2 — 持股**:`holdings` CRUD(列表 + inline 編輯 / 新增 / 刪除)
- [ ] **Tab 3 — Watchlist**:`watchlist` CRUD
- [ ] **Tab 4 — Paper Trade**:模擬下單表單 + paper positions 列表
- [ ] **Tab 5 — 個股**:歷史 K 線 + 技術指標 + 警示歷史(可從其他 tab 點 symbol 跳過來)
- [ ] **Tab 6 — Alerts**:`alert_rules` CRUD + `alert_events` 歷史

### 全域
- [ ] **Provisional 資料明確標示**(角標 / tooltip / 灰字)
- [ ] 寫入操作走 server actions(用 service_role key)避免前端 bundle key

**Review**:_(完成後填)_

---

## M6 — 部署上線收尾(0.5 day)`analyst-deployer`

- [ ] Railway 環境變數設齊(`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `FINMIND_TOKEN`)
- [ ] Production smoke test:從 0 連到 prod URL → 看到 dashboard → 在持股 tab 改一筆 → 看到改動
- [ ] README.md 寫部署/環境變數說明

**Review**:_(完成後填)_

---

## M7(選配) — 通知

- [ ] LINE Notify 或 LINE Messaging API 串接
- [ ] `alert_events` 觸發時推 LINE
- [ ] 每日盤後摘要(總損益、警示清單、paper vs real 對照)

---

## 後續可考慮(目前不在範圍)

- 自動策略執行 / 回測引擎
- 限價單 / 停損單模擬
- 多 user 登入(改用 Supabase Auth)
- 跨市場(美股、加密貨幣)
