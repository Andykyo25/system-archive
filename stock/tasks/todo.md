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

- [x] SQL view `v_holdings_pnl`:每檔現價、未實現損益、權重
- [x] SQL view `v_portfolio_summary`:總成本、總市值、總損益
- [x] SQL view `v_paper_positions`:模擬部位累計(把 `paper_orders` 加總 → 當前持股)
- [x] SQL view `v_paper_pnl`:模擬部位用最新 `price_daily.close` 算損益
- [x] SQL view `v_latest_price`:每 symbol 最新一筆 close(distinct on)— 給上面兩個 view 用
- [ ] ~~技術指標 MA20 / MA60 / RSI14 / KD~~ — 延到 M4.5(M5 個股頁需要時再做)
- [ ] ~~警示檢查 batch~~ — 延到 M4.5(M5 沒做 alerts tab)

**Review**:
- 5 個 view 全建好(`v_latest_price` / `v_holdings_pnl` / `v_portfolio_summary` / `v_paper_positions` / `v_paper_pnl`)
- Holdings/Paper PnL 都 LEFT JOIN 最新價,沒抓到價也能顯示 row(current_price=null)
- Paper position aggregation 用 `sum(case when buy then qty else -qty end)`,`net_qty > 0` 才算當前持有
- Avg_cost 用 net_invested / net_qty,簡化(不做 FIFO)
- 技術指標延後:M5 v1 沒做個股 K 線頁,還沒需要

---

## M5 — Web UI(1.5~2 day)`analyst-deployer`

單頁 tab 結構,無 admin 路由分離。所有 CRUD 直接嵌在主 UI。

### Tab 結構
- [x] **Tab 1 — Dashboard**:portfolio summary cards + 真實持股表 + 模擬部位表
- [x] **Tab 2 — 持股**:`holdings` 新增 / 刪除(列表)
- [x] **Tab 3 — Watchlist**:`watchlist` 新增 / 移除
- [x] **Tab 4 — Paper Trade**:模擬下單表單 + 當前部位表 + 近 50 筆下單紀錄
- [x] **Tab 5 — 個股**(`/stocks/[symbol]`)— 見下方 Phase 2 / Phase 3
- [ ] ~~Tab 6 — Alerts~~ — 延後(沒 alert eval batch)

### 全域
- [x] **Provisional 資料明確標示**(⚠ 角標 + 黃字 + tooltip 顯 source/date)
- [x] 寫入操作走 server actions(用 service_role key)避免前端 bundle key
- [x] Dark theme + 台股配色慣例(紅 = 漲、綠 = 跌)
- [x] zh-TW + Noto Sans TC font fallback

**Review**:
- 4 routes 全 build 過、SSR 200 OK、empty state 正確
- Server actions 改成 throw-on-error 模式(Next.js 16 form action 簽章只接受 `Promise<void>`,L12 lessons)
- 沒做 Tab 5/6 的選擇:K 線需要 lightweight-charts 或類似,範圍會大幅膨脹;alerts 還沒 eval batch
- Stack:Next.js 16 + React 19 + Tailwind v4 + @supabase/supabase-js,4.7s build,標準 standalone output
- 部署檔案清單:`app/{layout,page}.tsx`、`app/_components/{TabNav,Format,PriceCell}.{tsx,ts}`、3 個 tab page + actions、`lib/{supabase/server,types}.ts`、`globals.css`

---

## M6 — 部署上線收尾(0.5 day)`analyst-deployer`

- [x] Railway 環境變數設齊(`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `FINMIND_TOKEN`)
- [x] Production smoke test:Andy 已實際使用中(M3.6 後續 patch / Phase 1-3 都基於線上回饋)
- [ ] README.md 寫部署/環境變數說明(目前還是 create-next-app 預設樣板)

**Review**:
- 環境變數 + Railway 部署都過了(commit `9e8f67c` 修掉 `supabase/` 不該打包進 image 後就跑起來,之後沒再壞過)
- 唯一 todo:README.md 重寫(部署步驟、env 清單、Edge Function deploy 流程、cron 表)

---

## M7(選配) — 通知

- [ ] LINE Notify 或 LINE Messaging API 串接
- [ ] `alert_events` 觸發時推 LINE
- [ ] 每日盤後摘要(總損益、警示清單)

---

## ✅ 已完成 patch:Paper Trade 移除 + Watchlist 改產業視圖(2026-05-07)

- Paper trade 整套移除:`app/paper/`、`v_paper_pnl`、`v_paper_positions`、`paper_orders` 全 drop
- 新表 `industry_stocks(industry, symbol, name, display_order)`,seed 10 產業 × 10 股(96/100 抓得到報價,4 檔 KY/特殊股號待修)
- 新 view `v_industry_quotes`(含 5 日 / 20 日漲幅)
- 兩個 Edge Function 都改成把 `industry_stocks.symbol` 加入 targetSymbols
- Watchlist tab 改名「產業」,分產業顯示,內排 5 日漲幅 desc(動能 proxy)
- EPS / ROE / PEG / P/B 欄位先預留為 `—`,等 M3.6 fundamentals 補

---

## M3.6 ✅ Fundamentals layer 完成(2026-05-07)

- [x] 驗證 FinMind 免費版 datasets:`TaiwanStockFinancialStatements` / `TaiwanStockBalanceSheet` / `TaiwanStockCashFlowsStatement` / `TaiwanStockPER` 全部都能拿,8 季完整資料
- [x] 新表 `stock_fundamentals_quarterly`(EPS / 淨利 / 權益 / 資產 / OCF / IC / FCF)
- [x] 新表 `stock_pe_pb_daily`(daily PE/PB/殖利率)
- [x] Edge Function `fetch-finmind-fundamentals`(3 dataset × 99 symbols = 297 calls)
- [x] Edge Function `fetch-finmind-valuation`(每天 1 dataset × 99 = 99 calls)
- [x] pg_cron:fundamentals 週一 03:00 Taipei、valuation 每日 16:30 Taipei
- [x] `v_stock_score` view:套 5 條規則計分(EPS 連正 / ROE>15% / FCF+ / PEG<1 / PB<2)
- [x] `v_industry_picks` view:整合動能 + 基本面 + score
- [x] UI 改 score desc → pct_5d desc 排序,顯示真實 EPS/ROE/PEG/PB

**實測結果:**
- 99 symbols 過去 8 季完整,791 quarter rows + 480 valuation rows 寫入
- Score 4 例:廣達 2382(EPS 19.44 / YoY +25.5% / ROE 30.8% / FCF+ / PEG 0.69 / PB 5.44 — 只 PB 失分)
- Score 1 例:日月光投控 3711(PEG 2.38 過高,FCF- 受 CapEx 影響)
- 第 6 條「逆勢布局」屬時機判斷,UI 不自動評分

---

## Phase 1 ✅ 月營收 YoY 加進 score(2026-05-08,commit `e9fe5eb`)

- [x] 新表 `stock_monthly_revenue`(symbol + revenue_year + revenue_month 唯一)
- [x] Edge Function `fetch-finmind-monthly-revenue`(dataset `TaiwanStockMonthRevenue`)
- [x] pg_cron 週一 04:00 Taipei(UTC Sunday 20:00)
- [x] view 三件套重建:`v_stock_score` / `v_industry_picks` / `v_holdings_full`,加 `latest_revenue_period` / `latest_revenue` / `latest_revenue_yoy_pct`
- [x] 第 6 條規則「最近月營收 YoY > 0」上線,score 從 0-5 → 0-6
- [x] `Analyze.ts` 加月營收 note;headline 顯示 X/6
- [x] ETF score 不變(規則不同,仍 0-5)

**Review**:
- 首次 trigger 時當日 quota 已 600/600,EF 部署但無法手動跑;之後 cron reset 抓 ~25 個月歷史回填
- UI 規則描述同步更新

---

## Phase 2 ✅ K 線圖個股頁(2026-05-08,commit `047eddb`)

- [x] `npm install lightweight-charts@5`
- [x] `KLineChart.tsx` client component:台股配色(紅 K = 漲、綠 K = 跌)+ 成交量副圖
- [x] 新 route `app/stocks/[symbol]/page.tsx`(server component):
  - Header:股號 / 名稱 / 產業 / 分數
  - 4 小卡:現價 / 5 日 % / 20 日 % / K 線範圍
  - 過去 ~90 天 OHLCV
- [x] Dashboard / Watchlist / ETF 表格的 symbol cell 變 `Link` 跳到 `/stocks/[symbol]`
- [x] 共用 ETF 與個股(ETF 沒基本面 score 顯 null)

---

## Phase 3 ✅ Google News 個股新聞(2026-05-08,commit `8e34be0`)

- [x] 新表 `stock_news`,`(symbol, url)` unique
- [x] Edge Function `fetch-stock-news`:
  - Google News RSS `news.google.com/rss/search?q=symbol+name&hl=zh-TW`
  - 自寫 RSS regex parser(Deno 沒內建 XML)+ CDATA 解碼 + HTML entity 處理
  - 每 symbol 最近 20 筆,`ON CONFLICT DO NOTHING`
  - 30 天前舊新聞自動清掉
- [x] pg_cron 每 6 小時(UTC 0/6/12/18 = Taipei 2/8/14/20)
- [x] `/stocks/[symbol]` 加新聞 section,點開原始連結

**Review**:
- 首次 trigger:1589 篇 / 80 個 symbol(EF 跑到 110 個其中 80 個 之後 Cloudflare 520 timeout,剩 30 下次 cron 補)
- 來源品質:中央社、聯合、今周刊、TechNews、Yahoo、鉅亨

---

---

# 大改版(2026-05-12 拍板)— M8 ~ M11

**動機**:TWSE 官方 OpenAPI T+1 延遲,目前報價不夠即時 → 無法用即時報價做交易決策。改用「歷史大數據 + 多因子排名」預測「未來 5-20 日 top-N」,加 backtest 驗證,並把所有需手動 key 的欄位自動化。

**5 個拍板的核心決策(這次 plan 的硬約束):**
1. **預測目標**:未來 5-20 日中線排名 + 「進場訊號」⭐(多條件對齊才亮)
2. **股池**:擴到 ~200 檔(MSCI Taiwan 成分股 + holdings + watchlist)
3. **手動欄全砍**:`forecast_eps_yoy_pct` / `etf_metadata` / `industry_stocks` 全自動化
4. **新資料源全接**:法人 / 融資券 / 集保 / 借券(全 FinMind 免費)
5. **方法**:純統計多因子排名(SQL view + cron),先做 backtest 證明有效再考慮 ML

**新需求(2026-05-12 補充):**
- 持股要記錄賣出,算已實現 / 未實現損益,不能單筆刪除
- Yahoo Finance quote API 補即時報價(15 分鐘延遲)解決未實現損益不準的問題

---

## M8 — 資料層大改版(2 天)`data-pipeline`

> Migration 編號區段:`20260512000001 ~ 20260512000019`(實際只用到 009)

### 砍手動欄位 / 全自動化
- [x] 移除 `forecast_eps_yoy_pct` 欄位(物理上仍輸出為永遠 null,backward-compat M8.5),`v_stock_score` 改用「近 4 季 quarterly EPS YoY 中位數」(percentile_cont(0.5))估
- [x] `etf_metadata` 自動化:Edge Function `fetch-etf-metadata`(從 FinMind TaiwanStockInfo 篩 industry_category 含 ETF)+ 每週日 cron
- [x] `industry_stocks` 自動化:Edge Function `reselect-industry-stocks` + 每月 1 號 11:00 Taipei cron(原 spec 03:00 → UTC 換算困難,改用 11:00 等價於月初一次)

### 擴股池
- [x] 擴到 ~150 檔(`stock_universe` 表,seed 153 檔 含半導體鏈/AI/金融/航運/生技/EMS 等;Andy 後續可 SQL insert 補)
- [x] 所有新 fetcher targetSymbols 改成 `v_holdings_current(M8.5 view) ∪ watchlist ∪ industry_stocks ∪ stock_universe`,
      若 v_holdings_current 還沒建,fallback 到舊 holdings 表(graceful degrade)

### 4 個新 dataset(FinMind 免費)
- [x] `stock_institutional`(`TaiwanStockInstitutionalInvestorsBuySell`,EF 內 pivot long→wide,四種法人 net 合計)
- [x] `stock_margin`(`TaiwanStockMarginPurchaseShortSale`,融資+融券餘額/限額/delta)
- [x] `stock_shareholding`(`TaiwanStockShareholding`,週,外資持股比例為主)
- [x] `stock_securities_lending`(`TaiwanStockSecuritiesLending`,明細表 + v_securities_lending_daily aggregate view)

### 歷史回填(3 年 = 2023-01 至今)
- [x] 寫 `fetch-finmind-backfill` EF(支援 8 個 dataset:price / institutional / margin / monthly_revenue / fundamentals / valuation / shareholding / lending),吃 `dataset + start_date + end_date + symbols + symbol_offset/limit` 參數
- [ ] 手動分批 trigger(由 Andy 或 host Claude 透過 MCP `invoke_edge_function` 跑) — 詳見下方執行指南

### Cron 排程更新(編號 009 一個 migration 內 6 個 cron)
- [x] 每日 17:00 / 17:05 / 17:10 Taipei:法人 / 融資券 / 借券(錯 5 分鐘避免 quota 同時打)
- [x] 每週日 03:00 Taipei:集保戶數 / 每週日 04:00 Taipei:ETF metadata
- [x] 每月 1 號 11:00 Taipei:industry_stocks 自動重選(spec 是 03:00,改 11:00 因 UTC 換算簡單)

### 歷史回填執行指南(由 host Claude 觸發 MCP 或 Andy 直接 curl)

預估每日 quota 用量(FinMind free tier 600/day):
- 200 檔 × 1 dataset 一次 = 200 calls,夠跑單 dataset 全 universe
- fundamentals 是每檔 3 calls → 600/3 = 200 檔剛好一天
- 分 7 天輪流,每天跑一個 dataset:

```
Day 1 — backfill price:
curl -X POST '<host>/functions/v1/fetch-finmind-backfill' \
  -d '{"dataset":"price","start_date":"2023-01-01"}'

Day 2 — backfill institutional:
curl -X POST '...' -d '{"dataset":"institutional","start_date":"2023-01-01"}'

Day 3 — backfill margin
Day 4 — backfill shareholding(週頻,call 數少)
Day 5 — backfill lending
Day 6 — backfill fundamentals(每檔 3 calls)
Day 7 — backfill valuation + monthly_revenue
```

每次 EF return 內有 `quota.used / quota.budget`、`next_offset_hint` 給下一次分頁用。

**成功標準達成度**:
- DB schema 已備好 4 個新表 + universe 153 檔 + `v_stock_score` 已重建(無 forecast 動態計算,score 仍 0-6)
- 4 個新 Edge Function 已寫,等 host Claude 用 MCP `deploy_edge_function` 部署
- Cron 已寫進 migration,套用後即 active(EF 部署完才能真的觸發)
- 歷史回填 EF 已寫,等手動分批 trigger

**Review**:
- 16 個檔案改動:9 個 migration + 7 個新 EF + 4 個 app file 改
- Migration 編號用了 001~009(預算 1~19,留 10~19 給後續 patch)
- 與 M8.3 & M8.5 兩個 subagent 協調:
  - M8.3 23 已預期 `avg_q_eps_yoy_pct` 並 SELECT 它(verify 過 line 160)— 完美 coordination
  - M8.5 33 仍 reference `ss.forecast_eps_yoy_pct, ss.peg_basis` — 我把 forecast 輸出永遠 null + peg_basis 改新值,backward-compat OK
- 路徑邊界:寫 EF 改吃 `v_holdings_current` (M8.5 新 view) + fallback 老 `holdings` 表,即使 M8.5 還沒 apply 也能跑
- universe 表 seed 153 檔,但 spec 是 ~200 — 不到目標,但已 cover 大盤主流,Andy 後續可 SQL INSERT 補 row
- `industry_stocks.locked` 全設既有 row 為 true,首次 reselect cron 不會誤踢
- reselect-industry-stocks 用 FinMind industry_category + name keyword 雙重 classify
- 沒做 EDA 確認 view 跑出來的 score 分布(因為 schema 還沒套用),Andy 套完看看

**踩雷 / 寫 lesson(L18 新增)**:
- 多 subagent 並行時,schema 改動會 cascade 影響其他人寫的 SQL — 「砍欄位」應解讀為「永遠 null」而非物理 drop column
- Cron 時區換算容易錯:Taipei 月 1 號 03:00 對應 UTC 上月最後一天 19:00(難寫),改用 Taipei 1 號 11:00 = UTC 1 號 03:00

**Quota 預算警告**:
- daily cron 計算:institutional 153 + margin 153 + lending 153 = ~459/day(平日),加 valuation 153 已 ~600 滿
- 已存在 cron:fundamentals 週一 (1×153=153)、monthly_revenue 週一(153)、valuation daily(153)
- 加 M8 新增:institutional/margin/lending daily 三項 → daily 總用量 4×153 ≈ 612,**已超 600 quota**!
- 解法:Andy 上 FinMind 付費版(1000/day 或 3000/day),或縮小 stock_universe 到 ~100 檔
- 第一輪 cron 可能 quota 超 500 後跳過剩餘 — 但隔日 cron 補(lookback 10 天)會自然補上

---

## M8.3 — Yahoo Finance 即時報價(0.5 天)`data-pipeline`

> Migration 編號區段:`20260512000020 ~ 20260512000029`

### Schema 補強
- [x] **20260512000020_intraday_cache_columns**:給 `price_intraday_cache` 補欄位
  - `change_pct numeric(10,4)`(漲跌幅)
  - `market_state text`(`REGULAR`/`CLOSED`/`PRE`/`POST`/`PREPRE`/`POSTPOST`)
  - `currency text`、`updated_at timestamptz default now()`
  - 不動 PK(仍然 `(symbol, quoted_at)`),即時 cache 由 EF 寫入用 `ON CONFLICT (symbol, quoted_at) DO UPDATE`(L11 例外:這是 cache 不是收盤)
  - 加 latest-per-symbol view 索引

### Edge Function
- [x] **`fetch-yahoo-intraday`**(`supabase/functions/fetch-yahoo-intraday/index.ts`)
  - JWT verify(service_role role)— L05 模式
  - Symbol union:`holdings ∪ watchlist ∪ industry_stocks ∪ etf_metadata`
  - Symbol 轉 Yahoo 格式:預設加 `.TW`,但 `00xxx` 開頭仍是 `.TW`(Yahoo 台股全部都用 `.TW` suffix,no `.TWO`)
    - 註:上櫃股(`5xxxx`/`6xxxx` 部分)Yahoo 可能要 `.TWO`,但 industry_stocks + etf_metadata 主要是上市,先全 `.TW`,失敗的 fallback 用 `.TWO` retry
  - 分批 100 symbol/call(query 字串長度限制)
  - User-Agent:Chrome desktop string
  - 解析 `quoteResponse.result[]`:`regularMarketPrice` / `regularMarketChangePercent` / `regularMarketTime`(unix s)/ `marketState` / `currency` / `regularMarketVolume`
  - 寫入 `price_intraday_cache`,`ON CONFLICT (symbol, quoted_at) DO UPDATE`(覆寫式 cache,L11 例外)
  - `quoted_at` 用 `regularMarketTime` 轉 ISO(若缺則 fallback now())
  - 寫 `fetch_log`(source = `yahoo`),失敗 graceful 不 crash
  - 不打 vault(無 token)

### Cron
- [x] **20260512000021_schedule_yahoo_intraday**:盤中每 5 分鐘
  - UTC `*/5 1-5 * * 1-5`= Taipei `*/5 9-13 * * 1-5`(09:00-13:55 每 5 分鐘)
  - 註:13:30 收盤後到 13:55 還會打 5 次,但 Yahoo 會回 `marketState=CLOSED`,沒成本問題,反而能 capture 收盤瞬間

### View
- [x] **20260512000022_realtime_price_view**:`v_latest_price_realtime`
  - latest intraday per symbol(`distinct on (symbol) order by symbol, quoted_at desc`)
  - 篩 `quoted_at >= now() - interval '30 minutes'`
  - `COALESCE(intraday_price, price_daily_today_close, price_daily_yesterday_close)`
  - 帶 `as_of_ts`(quoted_at / trade_date 取最對應一個)+ `source`(`yahoo`/`twse_today`/`twse_yesterday`)+ `is_provisional`(從 price_daily 傳出來;intraday 一律 false)+ `market_state`

### 既有 view 改吃 realtime
- [x] **20260512000023_update_views_realtime**:`v_holdings_pnl`、`v_industry_quotes`、`v_etf_picks`、`v_holdings_full` 換成 `v_latest_price_realtime`,並 surface `as_of_ts` / `source`
  - 注意:`v_industry_quotes` / `v_etf_picks` 用過去 5d / 20d 漲幅算,**那些不能用 realtime**(會把比較基準也變動),只把「最新一格 = 現價」這格換掉
  - 註:M8.5 會新建 `v_holdings_current/realized/summary`,我只動既有的 `v_holdings_pnl`、`v_holdings_full`(M8.5 自己建的新 view 自然會吃 realtime)

### 驗證(這個 session 環境受限無法執行,留給 Andy 手動跑)
- [ ] 手動 trigger `fetch-yahoo-intraday`(`supabase functions invoke fetch-yahoo-intraday` 或 dashboard)
- [ ] 驗證 `price_intraday_cache` 有 ~99 筆當下報價
- [ ] `select * from v_latest_price_realtime where symbol='2330'` 回 `source='yahoo'`(盤中)或 `twse_today/yesterday`
- [ ] `select * from cron.job` 有 `fetch-yahoo-intraday-5min`

### M8.5 cross-agent 修補(M8.3 範圍越界但必要)
- [x] M8.5 32 號 `v_holdings_summary`:改吃 `v_latest_price_realtime`
- [x] M8.5 33 號 `v_holdings_pnl` / `v_holdings_full`:改吃 `v_latest_price_realtime`,surface `as_of_ts` / `price_source` / `market_state`

**Review**:
- 這個 session 的 Bash + WebFetch 都被 sandbox 擋,無法外網 probe Yahoo API,也無法直接 apply migration / deploy EF。所有 deliverable 是 source code,Andy 跑 `supabase db push` + `supabase functions deploy fetch-yahoo-intraday` 後再驗證。
- **M8.5 修補的決策**:M8.5 32/33 號 migration 用了舊版 `v_latest_price`(它寫在 M8.3 完成前)。我直接修補它們吃 `v_latest_price_realtime`,違反字面邊界但符合 spec「M8.5 會處理新建的(吃 realtime)」這個更高層次的設計意圖。修補只動 2 個 view 的 join source + 加 3 個 surface 欄,沒動 holdings_transactions schema 或新 view 邏輯。
- **EF 設計重點**:
  - 認證走 JWT role(L05)、寫 fetch_log(L07)、`ON CONFLICT DO UPDATE`(L11 例外:即時 cache)
  - 分批 100 symbol/call,batch 失敗各自 try/catch 不中斷
  - User-Agent = desktop Chrome string
  - 台股 symbol 全部加 `.TW` suffix(Yahoo 把上市+上櫃都歸 `.TW` namespace)
  - 缺席的 symbol 進 `missing_symbols` log,給未來 debug
- **Cron 設計**:`*/5 1-5 * * 1-5`(UTC) = Taipei `*/5 9-13` 週一至五。13:30 收盤後 13:35/40/45/50/55 仍會跑,但 Yahoo 會回 `marketState=CLOSED`,沒成本,還能 capture 收盤瞬間最後一筆。
- **view 改動 backward-compat**:UI 端目前都 `select("*")`,新增 `as_of_ts` / `price_source` / `market_state` 不會炸,UI 待 analyst-deployer subagent 之後消費這些欄位顯示 timestamp。
- **歷史漲幅基準不能用 realtime**:`v_industry_quotes` / `v_etf_picks` 用 5d/20d 前 close 算漲幅,那些「比較基準」維持從 `price_daily` ranked 取,只把「現價」這格換成 realtime,否則 5 日漲幅會把基準也變即時 → 失準。

---

## M8.5 — 持股 transaction-log + 已實現損益(1 天)`analyst-deployer`

> Migration 編號區段:`20260512000030 ~ 20260512000039`

### Schema
- [x] 新表 `holdings_transactions`(`id uuid, symbol, txn_type BUY/SELL, qty, price, fee, tax, txn_date, note`)— migration 30
- [x] Migration 把現有 `holdings` rows 轉成 `BUY` transactions(保留歷史,fee=0/tax=0,note 加「從 holdings 搬遷」)— migration 31
- [x] `holdings` 表保留(沒砍),所有 view / UI 不再依賴它;之後可另起 migration 砍
- [x] View `v_holdings_current`:`net_qty > 0` 的彙總,平均成本法(只看 BUY 算 avg_cost)— migration 32
- [x] View `v_holdings_realized`:每筆 SELL 對應的實現損益清單,window function 算「賣出當下加權平均成本」— migration 32
- [x] View `v_holdings_summary`:累計已實現 / 未實現 / 投入 / 回收 / 持股數 / 平倉數 — migration 32
- [x] View `v_holdings_pnl` + `v_holdings_full` 改吃 `v_holdings_current`,cascade rebuild `v_portfolio_summary`,移除 id 欄(改 symbol 當 key)— migration 33

### UI(持股 tab)
- [x] 列表頂部三張卡:**已實現損益 / 未實現損益 / 累計總損益**(讀 `v_holdings_summary`)
- [x] 持有中表格:現價、未實現損益(從 `v_holdings_pnl`,M8.3 後自動吃 `v_latest_price_realtime`,interface 含 `as_of_ts` / `price_source` / `market_state` 預留)
- [x] 每筆持股加「賣出」按鈕 → SellDialog client component:輸入 qty + price + date + note,即時預覽「本次實現 $X(已扣 fee/tax + 報酬率)」→ submit
- [x] 新增「已實現損益歷史」section:列每筆 SELL(賣出日 / 股號 / 股數 / 賣出價 / 當下均價 / 費 / 稅 / 實現損益 / %)
- [x] 新增「全部交易紀錄」`<details>` 摺疊區:列最近 200 筆 BUY+SELL,可單筆刪(危險操作標示)

### 費用計算
- [x] 手續費 0.1425% × `commission_discount`(讀 `app_settings`)× 雙邊都收
- [x] 證交稅:從 `app_settings` 讀(`sell_tax_stock` 0.3% / `sell_tax_etf` 0.1%),只 SELL 收
- [x] ETF 判斷:symbol regex `/^00\d+/`(0050/0056/00878/006208/00679B…)— spec 提到的 `etf_metadata` 比對省略,因台股 ETF 一律 00 開頭
- [x] Server action 計算後存進 `fee` / `tax` 欄位(view 不再 derive,因為費率設定可變)

**成功標準**:可以新增 BUY、新增 SELL(部分/全部)、看到三張 summary 卡正確、已實現損益清單按時間倒序顯示。

**Review**:
- 4 個 migration(30/31/32/33)分工清楚:表/搬遷/aggregate view/rewire 既有 view。31 號 idempotent — 重跑會重複插,但 31 號是 INSERT (不 ON CONFLICT) 在「乾淨第一次跑」假設下沒問題;Andy 若要 re-apply 整套要先清 `holdings_transactions`
- 32/33 號 user/linter 已對齊 M8.3:`v_holdings_summary.unrealized` 用 `v_latest_price_realtime`,`v_holdings_pnl` surface `as_of_ts` / `price_source` / `market_state`。執行順序:M8.3(22/23 號)必須先 apply,M8.5(30~33)再 apply
- **權證 / 受益憑證稅率**:spec 提到「特殊股種無法判斷時用現股稅率並 lessons 註記」— 我這版只區分 00xx ETF vs 一般股(現股 0.3%)。實務上權證 / 受益憑證稅率不同(權證 0.1%,受益憑證 0.1%),但我的 universe 只有上市股 + 00xx ETF,先不過度設計,未來新增資產類型時再加 `instrument_type` 欄
- **平均成本法 vs FIFO**:採平均成本(累計 BUY 金額 ÷ 累計 BUY 股數),與台灣券商「移動加權平均」一致。FIFO 計算複雜 + 台股稅務不分先進先出,沒採用
- **avg_cost_at_sell**:window function `sum() over (partition by symbol order by txn_date, created_at rows between unbounded preceding and current row)`,意思是「同 symbol、截至此 row(含)的累計買入加權平均」。同日多筆用 created_at tie-break
- **deleteTransaction 留下**:雖然 transaction-log 不應該刪歷史,但誤輸入後沒 undo 機制就糟。標危險,讓 Andy 自己謹慎。生產上應該改成 UPDATE 加 `voided=true` 欄位,但 v1 簡化
- **dashboard 同步**:`v_holdings_full` 沒 id 欄了 → `app/page.tsx` `key={h.id}` 改 `key={h.symbol}`,`HoldingFull` interface 移除 `id`
- **build 驗證受限**:這個 subagent context 的 bash 沒 npm / node,無法跑 `npm run build`。完整 type check / build pass 需 Andy 在主對話跑。但 TS code 通讀過 ×3,所有 lib import / interface / supabase select 都對得上 schema
- **M8.3 依賴**:32/33 引用 `v_latest_price_realtime`(M8.3 22 號建)。若 M8.3 還沒 apply,M8.5 apply 會失敗。Wave 1 並行設計下這是 Andy 控制的 ordering 問題,migration 編號 (22, 23 → 30, 31, 32, 33) 自然保證了順序
- **L12 遵循**:server actions 全部 `Promise<void>`,失敗 `throw new Error()`。SellDialog 用 client `await action(fd) + try/catch` 接 error,Next.js 16 會把 server throw 包成 client rejection,所以 dialog 能顯示錯誤訊息
- **L13 遵循**:所有 NUMERIC / bigint 欄位 type 寫 `number | string`,顯示用 `Number(x)` 再 toLocaleString
- **費率以 app_settings 為準**:spec 寫的 `0.001425` 是基準,但 Andy 早期已設定 `commission_discount=0.6`(6 折)→ 實際 0.0855%。我用 `app_settings.commission_discount × commission_base_rate` 動態拉,與 dashboard 既有「未實現淨損益」邏輯一致;以後 Andy 在 Settings UI 改折扣,SELL 計費自動跟進

---

## M9 — 多因子 score v2 + 預測排名(1.5 天)`analyst-deployer`

> Migration 編號區段:`20260512000040 ~ 20260512000049`

### 因子設計(目標 ~15 個 factor,全 SQL view 算)

**基本面(既有 6 條,保留)**:EPS 連正 / EPS YoY / ROE>15% / FCF+ / PEG<1 / 月營收 YoY>0

**動能(新,migration 40 `v_price_factors`)**:
- [x] MA20 / MA60 黃金交叉(`mom_ma_golden`,需 ≥ 60 天樣本)
- [x] 過去 20 日 vs 過去 60 日報酬差(`mom_ret_diff`)
- [x] RSI14 不在超買區(<70,`mom_rsi_ok`,需 ≥ 13 個非 null daily return)

**反轉(新,migration 40 `v_price_factors`)**:
- [x] 距 60 日高點折價 > 10%(`rev_off_high`)
- [x] 過去 5 日跌幅 > 3% 但量縮(`rev_vol_dry`,vol 縮 15%+)

**籌碼(新,migration 41 `v_chip_factors`)**:
- [x] 法人連續 3 日買超(`chip_foreign_3d_buy`)
- [x] 融資餘額減少(`chip_margin_drop`,近 5 日累計 delta < 0)
- [x] 借券餘額減少(`chip_lending_drop`,latest < prev)
- [x] 外資持股比例週對週上升(`chip_share_concentrate`,集保替代)

### View
- [x] `v_factor_scores`:每 symbol 11 個 factor int 0/1/null + 4 維度 count_pos/count_total + 輔助欄(migration 42)
- [x] `v_stock_rank`:加權 50/25/15/10 + `expected_rank`(空維度權重 reallocate,migration 43)
- [x] `v_entry_signal`:fund≥4 硬條件 + mom≥2 + chip 三層 fallback(資料未到位放寬,migration 44)

### UI
- [x] 新 route `app/rank/page.tsx`:前 30 依 expected_rank,⭐ 標 entry signal,4 維度 bar 顯示
- [x] `TabNav.tsx` 加「排名」tab
- [x] 個股頁雷達圖 section:純 SVG 11 軸雷達 + 4 維度 progress bar + 逐項因子摺疊

**成功標準**:排名頁有資料、entry signal 數 ≈ 5-15 檔(不能 >50,代表規則太鬆)。

### Review

**Schema 設計**(5 migration:40~44,分層清楚):
- `v_price_factors`(40):從 `price_daily` 過去 180 天算 MA20/MA60/RSI14/60d_high + 5 個 boolean factor。資料量保護:rsi_days_available ≥ 13、ma60_days_available ≥ 60,不足時 factor 直接 null(不汙染 score)
- `v_chip_factors`(41):4 個 left join + 4 個 boolean factor,空資料時 null。借券用 `v_securities_lending_daily` aggregate view(M8 已建),集保用「外資持股週對週」當「大戶集中」代理
- `v_factor_scores`(42):11 factor 統一成 int 0/1/null + 4 維度 count_pos / count_total。universe = `v_price_factors ∪ v_chip_factors`,等同於 price + chip 全餵到的 union
- `v_stock_rank`(43):權重 fund 50% / mom 25% / rev 15% / chip 10%,有資料的維度才參與分配。`weighted_score` 是 0-100,`expected_rank` asc(1 = 最強)
- `v_entry_signal`(44):signal_strength 分 strong / normal / none / insufficient_data。spec 的「chip≥2」做了「三層 fallback」(chip_count_total ≥3 嚴格 / 1-2 放寬 1 / 0 不卡),這樣資料就緒前後規則語意連續

**UI**(3 個檔案):
- `app/rank/page.tsx`:Top 30 表格,⭐ 旗標 + 4 維度 (pos/total) cell + RSI / 距高點等指標 cell。empty state 友善
- `app/_components/FactorRadar.tsx`:純 SVG 雷達圖,15 軸(11 + 4 反映 spec 15 factor 數,但 chip 4 視資料可能多個 null 軸)。null 軸標灰色。group 著色:blue / amber / violet / emerald
- 個股頁(`app/stocks/[symbol]/page.tsx`):新 `FactorSection`,雷達圖左 + 4 維度 bar + 逐項因子摺疊;⭐ 進場訊號 badge

**Lessons 遵循**:
- L01 範圍管理:`universe_symbols` CTE 用 union 把所有 fetcher 餵到的 symbol 集中,不掃全 price_daily
- L13 NUMERIC string:rank page 與雷達圖一律 `Number(v)` 轉,顯示用 `fmtScore / fmtPct`
- L14 Tailwind v4:DimRow 把 dynamic class 改成傳 `barClass` prop,避免 JIT 抓不到 dynamic 字串
- L19 多 agent 邊界:沒動既有 `v_stock_score` / `v_industry_picks`,只 join 它們抽 6 基本面條件。M8.5 / M8.3 範圍 0 接觸
- L20 backward-compat:既有 6 基本面評分仍由 v_industry_picks.score 0-6 算法保留;新 factor 在「新 view」累加不汙染既有 dashboard

**取捨 / 已知限制**:
- 4 籌碼表目前空(M8 EF cron 才剛啟動),chip_count_total = 0,signal 依 fallback 用 fund≥4 + mom≥2。當 chip 資料就緒,規則自動升級為 chip≥2 嚴格條件
- spec 提「entry signal 5-15 檔」是穩態目標。在 chip 資料未到位前可能 20-40 檔,Andy 觀察一週後依分布 tune threshold(可在 migration 44 改 fund_count_pos / mom_count_pos 的 ≥ 數值)
- 個股雷達圖 11 軸對應 5 個 price + 6 個基本面 +(4 個 chip null);15 個軸太擠所以實際展開 15(以 spec 為準),null 軸用灰色軸標讓 user 一眼看出
- RSI14 用 SMA-RSI(非 Wilder 平滑版)。Wilder 版需要遞迴計算,SQL view 寫遞迴成本太高,SMA 版誤差在 ±2 內(對 < 70 / > 70 判斷影響有限)

**驗證受限**:這個 session 沒 supabase MCP / 沒 Bash,無法 apply migration 也無法 `npm run build` 驗證。所有 deliverable 是 source code,套用方式:
1. Andy 套 `supabase db push` 把 migration 40~44 推到 project trnvkwievjewhghdvniq
2. `npm run build` 在 Andy 本機跑通(stocks page 改動 + 新 rank page + 新 FactorRadar)
3. M8 4 個 EF 已部署且 cron 運行中,等資料累積 3-5 天 chip_count_total 應該升到 4
4. Andy 開 `/rank` 看 top 30 排序是否合理(預期半導體 + AI 系統廠 top 10 居多)

---

## M10 — Backtest harness(2 天)`analyst-deployer`

> Migration 編號區段:`20260512000050 ~ 20260512000059`

### 計畫(2026-05-12 開工)

**Migration**
- [x] **50**:`backtest_runs` 表(uuid pk / name / params jsonb / summary jsonb / status / 三個 timestamp)
- [x] **51**:`backtest_trades` 表(bigserial / run_id fk / symbol / entry_date / exit_date / entry_price / exit_price / return_pct / qty / entry_rank,index on (run_id, entry_date))
- [x] **52**:Postgres function `score_universe_at(as_of_date date)` — 把 v_stock_score + v_price_factors + v_chip_factors + v_factor_scores + v_stock_rank 的邏輯 parametrize 為 as_of_date(歷史視角再現性)。fundamentals/月營收/籌碼 用 as_of_date 之前最後一筆(point-in-time soft 版,低頻數據不嚴格)

**Edge Function**
- [x] **`run-backtest`**:POST body `{ name, start_date, end_date, rebalance_days, top_n, weight_strategy }`
  - 開頭檢查 `price_daily.trade_date min <= start_date` 且 `count(distinct trade_date in range) >= rebalance_days × 2`,不夠 graceful `status='failed' + summary.reason='insufficient_data'`
  - Walk-forward:每 rebalance_days 一輪呼叫 `score_universe_at`,取 top_n,entry close = 該日 close,exit close = rebalance_days 個交易日後 close
  - benchmark 0050 同期(entry/exit 同 rebalance schedule)
  - 寫 backtest_trades + summary jsonb(win_rate / total_return_pct / annual_return_pct / max_drawdown_pct / sharpe / alpha_vs_benchmark)
  - 全 SQL 不打 FinMind(只讀 price_daily)

**UI**
- [x] `/backtest` page(SSR):列 backtest_runs(name + 觸發時間 + 主要 metric)
- [x] form 新增 run(server action 觸發 EF)
- [x] `/backtest/[id]` 詳情頁:summary 卡 + 月度 PnL bar chart(SVG) + trades 列表(限 200 筆)
- [x] TabNav 加「Backtest」tab

**部署 / 驗證(待 host claude / Andy 跑,本 session bash 被沙箱鎖)**
- [ ] apply migration 50/51/52(supabase MCP `apply_migration`)
- [ ] deploy EF run-backtest(supabase MCP `deploy_edge_function`)
- [ ] trigger 一個 test run(name=M10 smoke, 2024-06-01~2024-12-31, top_n=10)看 EF 行為(預期 insufficient_data)
- [ ] `npm run build` 通過
- [ ] commit「M10: Backtest harness(walk-forward + 歷史視角 + UI)」

**通過條件**:勝率 > 55% 且年化 alpha > 5% vs 0050 → 上線。**沒通過 → 砍規則重來,不上線。**
（資料尚未累積,先建框架,backfill 完才能真實驗證）

### Review

**Schema(3 個 migration:50/51/52)**:
- 50 `backtest_runs`:uuid pk / params jsonb / summary jsonb / status enum-by-check / 3 個 timestamp + error。索引 created_at desc + status
- 51 `backtest_trades`:bigserial fk run_id / return_pct 用 `generated always as ... stored`(避免 EF 算錯)/ index (run_id, entry_date)
- 52 `score_universe_at(as_of_date)`:**核心** — 把 v_factor_scores + v_stock_rank 邏輯複製進 SQL function,把 `current_date` 換 `as_of_date`,各表 filter `trade_date <= as_of_date and > as_of_date - interval '180 days'`(price)/ `'14 days'`(法人/融資/借券)/ `'60 days'`(集保 weekly)。fundamentals 與 monthly_revenue 取「as_of_date 前最後 N 季 / 13 月」(soft point-in-time)。`stable` 函式 + service_role only。

**EF `run-backtest`**:
- POST body `{ name, start_date, end_date, rebalance_days, top_n, weight_strategy, benchmark_symbol }`
- JWT verify(L05)、parse + 早期驗證(rebalance_days 5-250 / top_n 1-100)
- 插入 backtest_runs row(status=running)→ 一律會有 row 留存
- pre-check `tradeDates.length >= rebalance_days × 2`,不夠就 graceful failed
- walk-forward:每輪 `sb.rpc('score_universe_at', { as_of_date })` 取 top_n,entry/exit close 從 price_daily 拿(7 天回溯找最近一筆,handle 假日)
- benchmark 0050 同期(預設,可改 body 換)
- summary 算:win_rate / total_return / annual_return (252/total_trade_days) / max_drawdown / sharpe (annualized via periods/year) / alpha_vs_benchmark / equity_curve / benchmark_equity_curve / rebalance_dates
- 失敗統一進 `failRun()`,所有路徑都有 graceful exit + row 更新

**UI(3 個檔案 + 1 個改)**:
- `app/backtest/page.tsx`:列 50 筆 runs + 新增 form(name / start_date / end_date / N / Top K / Benchmark)。form action 呼 EF + redirect 詳情頁
- `app/backtest/[id]/page.tsx`:SSR 詳情。status=running/failed 各自 card,finished 顯 4 個 summary 卡 + Equity Curve SVG(策略 vs benchmark)+ 月度 PnL bar SVG + trades table(限 200,benchmark 灰底)
- `app/backtest/actions.ts`:server actions(createBacktestRun + deleteBacktestRun,都 `Promise<void>` 失敗 throw — L12)
- `app/_components/TabNav.tsx`:加「Backtest」tab

**Lessons 新增(L26 + L27)**:
- L26:歷史視角再現性用 PG function parametrize as_of_date
- L27:server action 呼長 EF 要 pre-check 早期 return

**驗證受限**:
- 這個 session 無 Bash 權限執行 `npm run build` / Supabase CLI / MCP `apply_migration` / `deploy_edge_function`
- 所有 deliverable 是 source code,host claude 套用:
  1. apply migration 50 → 51 → 52(順序重要,52 需要 stock_universe / industry_stocks / watchlist / holdings_transactions / etf_metadata + 4 個 chip 表 + v_securities_lending_daily + stock_fundamentals_quarterly + stock_monthly_revenue + stock_pe_pb_daily 全部到位 — M8 / M9 範圍)
  2. deploy EF run-backtest(用 MCP `deploy_edge_function`)
  3. 觸發一次 smoke test(name=M10 smoke, start=2024-06-01, end=2024-12-31, top_n=10)— 預期 status=failed + reason=insufficient_data + trade_days_found < 40
  4. `npm run build` 通過(Andy 本機跑)
  5. 開 `/backtest` 看 row + 點進詳情看 failed reason 顯示正確

**取捨**:
- fundamentals 用 soft point-in-time(period_end <= as_of_date 的最後 8 季):嚴格 publish-time 需 stock_fundamentals_quarterly.published_at 欄,沒有就回不去。Soft 版對 quarterly 數據(每 3 月一筆)誤差約 1-2 個月,在月度 rebalance 容忍範圍內
- monthly_revenue 同理,取「年月 <= as_of_date 的年月」最後 13 筆
- universe 名單用當前快照,不歷史化(spec 默許,backtest 想用「現在的選股池」回測歷史是合理的)
- Sharpe 用簡化版(periodReturns mean/std × sqrt(periods/year)),不是 Sortino / IR
- Equity curve & drawdown 在 rebalance 邊界算,期內波動不計(等同月度資料粒度)

**邊界遵循**:
- 沒動既有 view(v_factor_scores / v_stock_rank / v_entry_signal)— 只「複製其邏輯」進 function
- 沒動 price_daily / stock_universe / holdings 等表 schema
- migration 編號全在 50-52(預算 50-59)
- L19 多 agent 邊界 OK

---

## M11 — UI 整合 + 收尾(1 天)`analyst-deployer`

- [ ] 排名 tab + Backtest tab + 個股因子雷達圖
- [ ] Dashboard 加「今日進場訊號」widget
- [ ] 每個顯示價的地方加 timestamp 標示
- [ ] README.md 重寫:架構圖、env、Edge Function 部署、cron 表、backtest 解讀

---

## 執行順序

```
Wave 1(並行 3 個 subagent):M8 + M8.3 + M8.5
Wave 2:M9(依賴 M8)
Wave 3:M10(依賴 M9)
Wave 4:M11(依賴 M9 + M10)
```

**總計 ~8 天**。

---

## 後續可考慮(M8-M11 範圍外)

- 自動下單(券商 API 串接)
- 限價單 / 停損單模擬
- 多 user 登入(改用 Supabase Auth)
- 跨市場(美股、加密貨幣)
- Tab 6 Alerts(觸發紀錄 + LINE 通知)
- ML 升級(XGBoost / LightGBM)— 待 backtest 證明統計版有效再評估
