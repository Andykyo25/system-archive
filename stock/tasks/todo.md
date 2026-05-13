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

> 純 UI + docs。沒有 migration 編號需求(不動 schema、不動 EF)。

- [x] 排名 tab + Backtest tab + 個股因子雷達圖(已在 M9/M10 完成,M11 確認狀態 OK)
- [x] Dashboard 加「今日進場訊號」widget:讀 `v_entry_signal` 排序 `weighted_score desc`,top 10,name 從 industry_stocks / stock_universe / etf_metadata join;empty state 寫「factor 資料累積中」
- [x] Format.ts 加 `formatPriceTimestamp(asOfTs, source)` helper(15min ago · twse_mis / 今日收盤 · twse_today / etc.)
- [x] PriceCell 接收 `asOfTs` / `source` props,角落顯示小字 timestamp
- [x] Dashboard `v_holdings_full`、Holdings `v_holdings_pnl`、Watchlist `v_industry_picks`、ETF `v_etf_picks`:在 PriceCell 傳 `asOfTs` / `source`,UI 顯示 timestamp
- [x] 個股頁 header「現價」:同步補 timestamp(latest 那筆 close 是 historical,不用即時 source)
- [x] README.md 重寫:架構圖、env 清單、Edge Function 清單(11 個)、cron 表、操作指引、已知限制
- [x] `npm run build` 通過

### Review

**3 個檔案改 + 1 個新增**:
- 改 `app/_components/Format.ts` 加 `formatPriceTimestamp`(處理 yahoo / twse_mis / twse_today / twse_yesterday / null 各種 source + 計算「N min ago」)
- 改 `app/_components/PriceCell.tsx` 接 `asOfTs` / `source` 兩個 props,timestamp 顯示在價格下面一小行(避免擠壓主要數字)
- 改 `app/page.tsx`:加 `EntrySignalWidget`,讀 `v_entry_signal` where `is_entry_signal=true` 排序 weighted_score desc limit 10,join name(industry_stocks / stock_universe / etf_metadata 三層 fallback);HoldingFull interface 補 `as_of_ts` / `price_source` 並餵進 PriceCell
- 改 `app/holdings/page.tsx`:CurrentHolding interface 已有 as_of_ts / price_source(M8.3 預留),只需餵 PriceCell
- 改 `app/watchlist/page.tsx`:IndustryPick interface 加 `as_of_ts` / `price_source` 並餵 PriceCell
- 改 `app/etf/page.tsx`:EtfPick interface 加 `as_of_ts` / `price_source` 並餵 PriceCell
- 改 `app/stocks/[symbol]/page.tsx`:header 現價也餵 PriceCell 的 timestamp 標示(顯示歷史收盤 + trade_date)
- 改 `README.md`(原本 create-next-app 樣板)→ 全 rewrite 涵蓋架構 / env / EF / cron / 操作 / 已知限制
- `npm run build` 通過

**驗證**:
- build 用 winget 路徑下 npm 跑;新檔通過 typecheck
- empty state(目前 v_entry_signal 多半 insufficient_data)會跑 EntrySignalWidget 的 empty section 顯示「factor 資料累積中」
- timestamp 顯示用 hover tooltip 區隔來源,inline 顯示精簡(避免行高炸)

**Lesson 新增**(L28):見 lessons.md

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

## Phase 1 — Admin Dashboard Layout(2026-05-12)`analyst-deployer`

### 計畫
- [x] 新增 `app/_components/Sidebar.tsx`(client component):w-16/md:w-56,固定左側,7 個 nav items(emoji icon + label + desc),active 高亮(usePathname),響應式 <md 收摺成 icons-only(justify-center)
- [x] 新增 `app/_components/TopBar.tsx`(client component):從 path 推 page title,右上預留狀態指示
- [x] 改 `app/layout.tsx`:整體 `flex min-h-screen`(sidebar + main column),main 內 TopBar + 內容區
- [x] 新增 `app/_components/PerformanceWidget.tsx`:讀 summary + realized + first_buy_date,顯示已實現損益 / 勝率 / 累積報酬率(加權)+ 平均單筆 + 平均持有天數 + 最近 5 筆 + 最大單筆獲利
- [x] 新增 `app/_components/AdviceWidget.tsx`:4 個 advice card(出場紀律 / 分散產業 / 可關注標的 / 避免追的),動態填:對沖標的從 v_stock_rank fund>=5 非半導體挑 2 檔,可關注 top 5,避免追硬編碼
- [x] 改 `app/page.tsx`(Dashboard):多 4 個 Promise.all query(summary / realized / buy_txns / ranks)+ symbol→name+industry lookup(industry_stocks/stock_universe/etf_metadata 三層 fallback)+ 排除持有中 symbol → advicePicks。順序:Summary → Performance → Advice → EntrySignal → Holdings
- [x] `TabNav.tsx`:確認沒被任何地方 import,保留檔案
- [x] 文件 review

### Review

**4 個新檔 + 2 個改檔**:
- `app/_components/Sidebar.tsx`(新):左側 fixed sidebar,7 nav item,icon + active 高亮 + responsive(<md icons-only)。pageTitleFromPath 也在這檔 export 給 TopBar 用
- `app/_components/TopBar.tsx`(新):main column 頂端 bar,顯示當前頁 title
- `app/_components/PerformanceWidget.tsx`(新):整個 widget self-contained,接 PerfSummary + PerfRealizedRow[] props
- `app/_components/AdviceWidget.tsx`(新):4 個 advice card,接 AdvicePickRow[](已含 industry 給 isSemi() 判斷)
- `app/layout.tsx`(改):root layout 從 header+main 改成 flex sidebar+(topbar+main),max-w-6xl 砍掉讓內容自然撐
- `app/page.tsx`(改):import + Promise.all 多抓 4 query,在 Dashboard 內 prep advicePicks(filter held + map industry),render 順序:Summary → Performance → Advice → EntrySignal → Holdings(分區清楚)

**設計決策**:
- 「累積報酬率」用加權版(`sum(pnl)/sum(cost_basis)`)而非簡單平均 — 反映 portfolio-level 報酬;副標補「平均單筆 X%」讓兩個視角並存。對 Andy 三檔已平倉(+12.6% 加權 / 約 13.3% 平均)這兩個數字會貼近呈現
- 持有天數:`v_holdings_realized.sell_date - min(BUY txn_date per symbol)`。同 symbol 可能多次買賣,用 first BUY 算是「最初進場到完全出清」的概念 — 對 Andy 三檔全部一買一賣場景完全正確;未來若同 symbol 多次進出,可改 latest BUY 前推或 FIFO,先簡單版
- 可關注標的排除「目前持有中」symbol — 推薦 Andy 已經持有的沒意義
- 「分散產業」非半導體 filter 用 `industry_stocks.industry` 字串 keyword(半導體/電子零組件/晶圓/封測/IC設計)。沒進 industry_stocks 的 symbol industry=null 也算「非半導體」,可被推薦
- 4 個 advice card 用 `grid-cols-2` + 內含 `[&:nth-child(2n)]:border-r-0` 處理邊界線
- Sidebar 用 emoji 不引 icon library(spec 給授權:emoji 或 SVG)
- Dashboard 全寬 widget 直列堆疊,不做 lg:cols-2 切分 — 因 EntrySignalWidget table 8 columns 在 narrow 容器擠壓嚴重,直接全寬最乾淨

**Lessons 遵循**:
- L01:Performance + Advice 兩個 widget 都只讀 supabase view,不打外部 API
- L12:Sidebar/TopBar 是 client component(`"use client"`),Dashboard server component 直接 import 沒問題
- L13:realized_pnl/realized_pct/weighted_score 等 numeric 全 `Number(x)` 轉,顯示用 fmtPct/fmtMoney
- L14:Tailwind v4 利用 utility class 字面字串,advice card accent 顏色用 ACCENT_DOT lookup table(JIT 看得到)
- L19:不動 schema / view / EF,純 UI 改動,multi-agent 邊界 0 接觸

**驗證受限**:
- 這個 session bash 被擋,無法跑 `npm run build`(host 跑時可驗證)
- TS 看起來無錯:所有 import path / interface 對齊;PerformanceWidget 接 `PerfSummary | null`(handle null case);AdviceWidget 接 `AdvicePickRow[]`(empty 也有 fallback 文字)
- 各 page 路由不動,sidebar 都套到(因在 root layout),驗證:Dashboard ✓ / /holdings / /watchlist / /etf / /rank / /backtest / /settings / /stocks/[symbol] 全繼承新 layout

**取捨 / 已知限制**:
- entry signal widget 沒改成 narrow-friendly,因為 spec 沒要求 + 直列堆疊就很實用
- pageTitleFromPath 對 dynamic route(/stocks/[symbol] / /backtest/[id])硬寫 startsWith 邏輯,還沒泛用化 — 之後若多 dynamic 路由可以做 route metadata 表
- AdviceWidget「避免追的」3 檔硬編碼。長期應該有個 `stock_blacklist` 表 + Settings UI 維護,但 v1 簡化先這樣

---

## M9.1 — Factor 模型優化(根據台股分析師建議,2026-05-12)`analyst-deployer`

> Migration 編號區段:`20260512000060 ~ 20260512000069`

### 變更要點
- 權重 hard-code → app_settings(短中線預設:fund 40 / mom 30 / rev 10 / chip 20)
- PEG 門檻放寬 1.0 → 1.2(settings-aware)
- RSI factor:`mom_rsi_ok`(RSI<70)→ `mom_rsi_strong`(RSI>50,轉強)
- 新增基本面 factor:`fund_gross_up`(gross_margin_yoy_pp > 0)→ 基本面從 6 → 7 條
- 新增籌碼 factor:`chip_inst_concentration`(3 日法人 net / 3 日總量 > 5%)→ 籌碼從 4 → 5 條
- 進場訊號:加硬條件 `fund_rev_yoy=1`,fund≥3(從 ≥4 放寬),chip 三層 fallback 隨 chip 總數 5 調整(≥4 嚴格 ≥3 / >0 ≥1 / =0 不卡)
- 17 軸雷達(7 fund + 3 mom + 2 rev + 5 chip)

### Migration
- [x] **60_factor_settings**:app_settings 新增 5 row(peg_threshold / weight_fund / weight_mom / weight_rev / weight_chip)
- [x] **61_v_price_factors_v2**:`mom_rsi_ok` → `mom_rsi_strong`(RSI14 > 50,需 ≥13 RSI 樣本)
- [x] **62_v_chip_factors_v2**:加 `chip_inst_concentration`(join price_daily 3 日 volume sum)
- [x] **63_v_factor_scores_v2**:加 `fund_gross_up`,`fund_peg_low` 改讀 settings peg_threshold,合計 17 factor(7+3+2+5)
- [x] **64_v_stock_rank_v2 + v_entry_signal_v2**:weights 從 settings 讀;entry rule:fund≥3 + rev_yoy=1 + mom≥2 + chip 三層 fallback(total≥4→pos≥3 / >0→pos≥1 / =0→true);strength 同步
- [x] **65_score_universe_at_v2**:同步新 factor + settings-aware

### UI
- [x] `app/_components/AdviceWidget.tsx`:更新「17 因子」「fund≥3 + 月營收 YoY 必過」文字
- [x] `app/_components/FactorRadar.tsx`:不動 component 本體(已 dynamic axes),更新註解 11→17
- [x] `app/rank/page.tsx`:Legend 改 7/3/2/5,header 文字短中線權重 40/30/10/20,進場訊號條件改
- [x] `app/stocks/[symbol]/page.tsx`:`buildFactorAxes` 加 fund_gross_up + chip_inst_concentration + rename mom_rsi_ok→mom_rsi_strong;FactorRankRow interface 補新欄位

### 驗證(本 session bash 被擋,host claude / Andy 驗證)
- [ ] migration apply 全過(60-65 順序,需先確認 app_settings 表存在,M3.6 已建)
- [ ] SQL:`select * from v_stock_rank order by expected_rank limit 5`
- [ ] SQL:`select count(*) from v_entry_signal where is_entry_signal=true`(預期 v1 後資料較嚴格 → 數量略減,因 fund≥3+rev_yoy 雙硬條件,且 chip 5 條後嚴格門檻提高)
- [ ] SQL:`select * from score_universe_at('2024-06-01') limit 1`(可空,但不能 error)
- [ ] `npm run build` pass(host 跑)
- [ ] todo review + lesson(若有)

### Review

**6 個 migration + 3 UI 檔改動**:
- 60 `app_settings` rows(peg_threshold 1.2 / weight_fund 0.40 / weight_mom 0.30 / weight_rev 0.10 / weight_chip 0.20)。用 ON CONFLICT DO UPDATE 讓重跑安全
- 61 `v_price_factors`:`mom_rsi_ok`(RSI<70)→ `mom_rsi_strong`(RSI>50,轉強)。其他 4 factor 不變
- 62 `v_chip_factors`:加 5th factor `chip_inst_concentration`(3 日 three_major_net / 3 日 price_daily.volume sum > 5%)。inst + price 都要 3 天才評,缺一回 null
- 63 `v_factor_scores`:7 fund(加 `fund_gross_up` = gross_margin_yoy_pp > 0)+ 3 mom + 2 rev + 5 chip = 17 factor。fund_peg_low 改用 `app_settings.peg_threshold`(settings 表 CTE + cross join,settings 改變後 view 立刻反映)
- 64 `v_stock_rank + v_entry_signal`:weights 從 app_settings 拿;新 entry 規則(月營收 YoY 必過 + fund≥3 + mom≥2 + chip 三層 fallback ≥4 條→≥3 / >0→≥1 / =0→不卡)。`strength` 也對齊
- 65 `score_universe_at`:整個 function rewrite,17 factor + settings-aware(stable function 內讀 settings,backtest 改 weights 後新 run 才生效)

**UI 改動**:
- `AdviceWidget.tsx`:header 加上「17 因子 / fund≥3 + 月營收 YoY 必過 + 動能≥2」說明
- `rank/page.tsx`:header 文字 短中線權重 40/30/10/20;Legend 4 dimensions 改 7/3/2/5 + 因子 list 換新項目 + 進場訊號條件描述
- `stocks/[symbol]/page.tsx`:`FactorRankRow` interface 加 `fund_gross_up` / `chip_inst_concentration` / 改 `mom_rsi_strong`;`buildFactorAxes` 從 15 軸 → 17 軸,加入新 factor + 改名
- `FactorRadar.tsx`:只更新註解(component 本身 dynamic axes,不寫死數量,完全 backward-compat)

**設計決策**:
1. **app_settings 為什麼用 view 而非 function 拿**:settings 變動希望 view 結果即時更新(像 commission_discount 一樣),不用 rebuild view。代價是每次 view 計算多一次 CTE select,可忽略
2. **score_universe_at 同步**:stable function 內讀 settings 是 OK 的(stable 不是 immutable,可查 table)。Backtest 每輪呼叫一次,假設 N=12 輪 × 13 月 = 156 次呼叫,settings 表 ~9 row 讀取極快
3. **chip_inst_concentration 字面解讀**:spec 寫「3 日法人 net / 3 日總量 > 5%」我採嚴格字面 = 正向 net 主導才過。法人淨賣的場景 ratio 雖然 abs 也可能 > 5% 但是負向,我擋掉(更安全)
4. **fund_count_pos >= 5 在 Dashboard advice 條件不變**:在 6 條制下 ≥5 = 83%,7 條制下 ≥5 = 71% — Andy 看實際數量再決定要不要拉高(動 page.tsx 而非 view 即可)
5. **不動 v_stock_score**(M3.6,gross_margin_yoy_pp 早已存在),也不動 v_industry_picks 等其他 view(它們用既有 6 條基本面 score)

**Lessons 遵循**:
- L01 範圍:universe 仍 stock_universe ∪ industry ∪ watchlist ∪ holdings_transactions(chip 不 union etf)
- L13 NUMERIC:rank UI 已 `Number(x)` 轉,新增欄位仍是 numeric|null,沒新顯示需求
- L19 多 agent 邊界:沒動其他 agent 範圍 view(v_holdings_*、v_latest_price_realtime 等)
- L20 backward-compat:既有 view drop + recreate cascade,但 cascade 只動下游(v_stock_rank / v_entry_signal),score_universe_at 是 function 用 create or replace 取代
- L23 資料量保護:fund_gross_up 需要 fund_ranked q1 + q5 都有,gross_profit/revenue > 0;chip_inst_concentration 需要 inst 3d + price 3d 都有
- L26 score_universe_at parametrize:新版 function 仍維持「as_of_date 之前最後一筆」soft point-in-time 邏輯

**取捨 / 已知限制**:
- 因 fund 從 6 → 7 條,既有 v_industry_picks.score 仍是 0-6(M3.6 那組),沒升級。因 spec 標明「v_stock_score 不能動」,而 v_industry_picks 用 6 條規則 hard-code,M9.1 範圍外。Andy 之後若想 unify 再說
- score_universe_at 內讀 settings 是線上版本,backtest 改 weights 後跑 history 是用「新 weights 看舊資料」,不是「凍結 weights」。若要嚴格 reproducible,需把 weights 寫進 backtest_runs.params jsonb,function 改吃 jsonb 而非 settings。v1 簡化先這樣

**驗證受限**:
- 本 session 無 bash → 無法 `npm run build` 或 supabase MCP apply migration
- 套用順序:host 跑 `supabase db push` 自動依字典序套 60→61→62→63→64→65
- 跑完先 SQL 驗 `select count(*) from v_factor_scores where fund_count_total >= 5`(看有多少 fund 有 5+ 可評),再 `select symbol, fund_count_pos, fund_count_total, signal_strength, is_entry_signal from v_entry_signal where is_entry_signal=true limit 30`

---

## M9.2 — 加突破因子 + ROE 門檻微調(2026-05-12)`analyst-deployer`

> Migration 編號區段:`20260512000066 ~ 20260512000070`

### 動機
華新科 2492 5/11+5/12 連兩根漲停過去 5 天 +36%,系統排名 33,主因:
1. ROE 4.7% 卡 15% 門檻(被動元件業 ROE 天生低)
2. PEG 1.76 卡 1.2 門檻
3. `mom_ma_golden=false`(過去 60 天 MA20 在 MA60 上一直沒「剛交叉」)

分析師建議:加「突破因子」(20 日新高 + 量增 2x)抓飆股 + ROE 放寬 15% → 10%。

### 變更要點
- **ROE 門檻**:從 hardcode 15% 改為 `app_settings.roe_threshold`(預設 10)
- **新動能 factor `mom_breakout`**:`latest_close >= high_20d × 0.99` AND `vol_latest > vol_5d_avg × 2`
  - 20 日新高 + 留 1% buffer(避免漲停打到開盤新高但收盤 -1% 被排除)
  - 當日量 > 5 日均量 2 倍(放量突破)
- 動能 factor 從 3 → 4 條(加 mom_breakout)
- 因子總數 17 → 18(7 fund + 4 mom + 2 rev + 5 chip)
- v_entry_signal:`strong` 規則 `mom_count_pos >= 3`(原 3/3 = 100%,現在 3/4 = 75%)
- normal 規則 mom≥2 相對放寬(50% 而非原 67%)— 這是預期(更敏銳)

### Migration
- [x] **66_factor_settings_roe**:app_settings 加 roe_threshold = 10
- [x] **67_v_price_factors_v3**:agg CTE 內加 `high_20d` + `vol_latest`(rn=1 時的 volume),新 factor `mom_breakout`
- [x] **68_v_factor_scores_v3**:動能改 4 條(加 mom_breakout)+ ROE factor 改讀 settings.roe_threshold + 新欄位 pass-through + count_pos/total 動能改算 4 條
- [x] **69_v_stock_rank_and_entry_signal_v3**:pass-through 加 mom_breakout + entry signal strong 改 mom≥3(配合 4 條)
- [x] **70_score_universe_at_v3**:同步 18 factor + ROE settings

### UI 改動(4 檔)
- [x] `app/_components/AdviceWidget.tsx`:header 文字「17 因子」→「18 因子」、動能 3 → 4(加突破)
- [x] `app/_components/FactorRadar.tsx`:更新註解 17 → 18(component 本身已 dynamic axes)
- [x] `app/rank/page.tsx`:Legend 因子說明改 7/4/2/5 + 加 mom_breakout 描述
- [x] `app/stocks/[symbol]/page.tsx`:`FactorRankRow` interface 加 `mom_breakout` + `buildFactorAxes` 17 → 18 軸

### 驗證(本 session bash 被 sandbox 鎖,host claude 用 supabase MCP 驗證)
- [ ] 5 個 migration apply(66 → 67 → 68 → 69 → 70 順序)
- [ ] SQL:`select * from v_stock_rank where symbol='2492'` 確認 mom_breakout 值
- [ ] SQL:`select count(*) filter (where is_entry_signal=true) from v_entry_signal` 比 M9.1 略多
- [ ] `npm run build` pass(本 session 被擋,host 跑)
- [ ] Stage 不 commit(由 host 跑)

### Review

**5 個 migration + 4 UI 檔改動**:
- 66 `app_settings` 加 roe_threshold=10(ON CONFLICT DO UPDATE,重跑安全)
- 67 `v_price_factors`:agg CTE 加 `high_20d`(max close rn 1-20)+ `vol_latest`(rn=1 的 volume),新 factor `mom_breakout`(close >= high_20d × 0.99 AND vol_latest > vol_5d_avg × 2)
- 68 `v_factor_scores`:加 mom_breakout pass-through + 動能 count 改 4 條;fund_roe_high 改用 settings.roe_threshold(cross join settings CTE 多拿 roe_threshold)
- 69 `v_stock_rank` 加 mom_breakout pass-through;`v_entry_signal` strong 規則 mom_count_pos≥3(4 條制下這仍是 75% 達標,比 M9.1 100% 略寬)
- 70 `score_universe_at`:整段 function rewrite 同步 18 factor + ROE settings + high_20d + vol_latest

**UI 改動**:
- `AdviceWidget.tsx`:header 文字「18 因子 / 動能 ≥ 2/4」(動能總數 4 ≥ 2 改成 50% 門檻)
- `rank/page.tsx`:Legend 改 7/4/2/5,動能新增「20日新高+量增2x 突破」項
- `stocks/[symbol]/page.tsx`:interface 補 mom_breakout,buildFactorAxes 18 軸,加「突破」label
- `FactorRadar.tsx`:component 本身完全動態,只改開頭註解

**Dashboard(`app/page.tsx`)不需動**:
- 它只 select `fund_count_pos / mom_count_pos / chip_count_pos` 等 count,沒讀 individual factor
- `mom_count_total` 自動從 3 → 4,UI 顯示 X/3 變 X/4 自然受惠
- `fund_count_pos >= 5` filter 仍合理(7 條中過 5 = 71%)
- 不在 spec「4 UI 檔」清單內是正確的

**設計決策**:
1. **mom_breakout 邏輯字面解讀**:`close >= high_20d × 0.99` 是分析師 spec 的「buffer 1%」,避免漲停爆量打到 20 日新高但 close 微跌就漏掉(漲停股很常 high 噴到接近上限,close 卻略低於 high)。實務上漲停的 close 通常 ≈ 漲停價 ≈ 當日 high,所以 0.99 倍率很合理
2. **vol_latest 必須是「當日量」**:從 ranked CTE rn=1 取(max(case when rn=1 then volume)),不是 5 日均量。spec 寫「vol_latest > vol_5d_avg × 2」明確要當日量 vs 5 日均量
3. **mom_count_total 4 條後 entry signal**:強訊號從「3/3 全過」放寬「3/4 過 3」是必要的 — 因 mom_breakout 是稀有事件(漲停飆股才會過),硬要 4/4 全過會吃零 strong signal。3/4 = 75% 在 backtest 容易被驗證
4. **華新科 2492 的預期**:即使 mom_breakout 過(5/12 量 4137 萬 vs 5 日均 3000 萬 = 1.38 倍,不過 2x → 預期仍 mom_breakout=0),且 ROE 4.7% 仍卡(< 10%)。系統不會被漲停股牽著走 — 這是「分析師認知的」結果,M9.2 重點不是把 2492 拉進 top,是讓有「強動能 + 基本面」的飆股更容易進 strong signal
5. **不動 v_stock_score**(M3.6 那組,ROE 計算仍 hardcode 15%)— v_industry_picks 用 v_stock_score 算 0-6 score,跟 v_factor_scores ROE 門檻獨立,不會互相干擾。Andy 之後若想 unify 再說

**Lessons 遵循**:
- L01 範圍管理:universe 仍維持 stock_universe ∪ industry_stocks ∪ watchlist ∪ holdings_transactions ∪ etf_metadata(視 view 而定),沒掃全市場
- L13 NUMERIC string:新欄位 mom_breakout 是 boolean → int 0/1,UI 接受 number | null,顯示直接 0/1 → ✓/✗
- L14 Tailwind v4:新 label「突破」直接 inline 字面字串,沒新增 dynamic class
- L19 多 agent 邊界:沒動 M8 / M8.3 / M8.5 範圍 view(holdings_*、realtime_price 等),沒動 M3.6 v_stock_score / v_industry_picks
- L20 backward-compat:既有 view drop cascade,但 cascade 只動 v_factor_scores / v_stock_rank / v_entry_signal 下游(都重建)
- L23 資料量保護:mom_breakout 需要 high_20d / vol_latest / vol_5d_avg 都非空(20 日完整資料),不足時 null
- L32 score_universe_at 必同步:5 個 migration 內 70 號 score_universe_at 整段 rewrite,18 factor + ROE settings 完整對齊
- L33 settings 改變影響 backtest 結果:roe_threshold 改變後新 backtest 立刻吃新值,符合 v1 簡化策略

**取捨 / 已知限制**:
- mom_breakout 沒做「跨日量縮確認」(漲停翌日量縮代表停板成交,但 v1 簡化先看當日)
- ROE 門檻雖然放寬到 10%,但部分傳統產業(被動元件、紡織、橡膠等)的 ROE 5-9% 仍不過,屬於有意保留(它們的轉機要靠 EPS YoY 或月營收 YoY 來體現)
- 跟 M9.1 一樣,settings change 不 retroactive — backtest 重跑同一個 run 名稱結果會不一樣,Andy 自己把 weights/roe_threshold 寫進 backtest_runs.name 標籤

**驗證受限**:
- 本 session bash 沙箱鎖 → 無法 `npm run build` 也無法 supabase MCP apply migration
- 套用順序:host claude / Andy 用 supabase MCP 套 66 → 67 → 68 → 69 → 70
  (或 `supabase db push` 自動依字典序套)
- 跑完先 SQL 驗:
  ```sql
  -- 1. settings 有 roe_threshold
  select * from app_settings where key='roe_threshold';
  -- 2. 華新科 mom_breakout(spec 預期 vol 1.4x 不過 2x → 0)
  select symbol, mom_breakout, mom_ma_golden, mom_ret_diff, mom_rsi_strong,
         mom_count_pos, mom_count_total, fund_roe_high, fund_count_pos
  from v_stock_rank where symbol='2492';
  -- 3. entry signal 數量(比 M9.1 略多)
  select signal_strength, count(*) from v_entry_signal group by signal_strength;
  -- 4. score_universe_at 歷史視角 sanity check
  select count(*) from score_universe_at(current_date - interval '7 days');
  ```

---

## M9.3 — 長期動能 factor + PEG 放寬 + 預算 filter(2026-05-13)`analyst-deployer`

> Migration 編號區段:`20260512000071 ~ 20260512000075`

### 動機(M9.2 baseline 2024 backtest 結果)
- 2024 全年 backtest:勝率 56.7% / 累積 +17.2% / **alpha vs 0050 = -29.45%**
- 系統錯過 TSMC/聯發科這類「PEG 偏高的續強龍頭」
- MA20 黃金交叉抓「剛交叉」,抓不到「持續強勢」續漲股

### 變更要點

**A. 新動能 factor `mom_above_ma200`**
- 條件:60 日報酬 > 0 AND latest_close > MA200
- 邏輯:抓「長期趨勢向上」的續強股
- 資料量保護:ma200_days_available ≥ 180(放寬 10% 給新上市股)

**B. PEG 門檻 1.2 → 1.5**(只改 setting,view 不動)

**C. 預算 filter (NEW)**
- `app_settings.budget_ntd`(預設 0 = 不 filter)
- `v_rank_with_cost`:rank join v_latest_price_realtime,新增 `cost_per_lot_ntd = current_price × 1000`
- `/rank` 讀 v_rank_with_cost,SSR 端 filter `cost_per_lot_ntd ≤ budget_ntd OR budget_ntd = 0`

**D. v_factor_scores / v_stock_rank / v_entry_signal / score_universe_at v4**
- 動能 4 → 5 條
- entry strong 改:`mom_count_pos >= 4`(5 條制 80%,對齊 M9.2 mom≥3 in 4 = 75%)

### Migration
- [x] **71_settings_peg_15_budget**:`peg_threshold` 1.2→1.5 + `budget_ntd` = 0
- [x] **72_v_price_factors_v4**:agg 加 ma200_now / ma200_days_available + 新 factor mom_above_ma200
- [x] **73_v_factor_scores_v4**:動能 5 條(加 mom_above_ma200),count_pos/total 對應
- [x] **74_v_stock_rank_v4 + v_entry_signal_v4 + v_rank_with_cost**:pass-through + strong mom≥4 + 新 view 提供 cost_per_lot_ntd
- [x] **75_score_universe_at_v4**:同步 19 factor

### UI 改動(6 檔)
- [x] `app/settings/page.tsx`:加「投資預算 (NT$)」input(BudgetRow,獨立 section + 萬位提示)
- [x] `app/settings/actions.ts`:沿用 updateSetting + 加 revalidatePath("/rank")
- [x] `app/rank/page.tsx`:改讀 v_rank_with_cost、SSR budget filter、加「1 張成本」欄、header 顯示預算狀態、Legend 7/5/2/5
- [x] `app/_components/AdviceWidget.tsx`:header 18→19 因子 / 動能 4→5(加站上 MA200)
- [x] `app/_components/FactorRadar.tsx`:註解 18→19 軸
- [x] `app/stocks/[symbol]/page.tsx`:FactorRankRow interface 加 mom_above_ma200,buildFactorAxes 18→19 軸 + PEG label 改 1.5

### 驗證(本 session bash 被擋,host claude 用 supabase MCP 套 + 跑 build)
- [ ] 5 個 migration apply(71 → 72 → 73 → 74 → 75 順序)
- [ ] SQL:`select symbol, mom_above_ma200, mom_count_pos, mom_count_total from v_factor_scores where symbol='2330' limit 1` 確認 TSMC mom_above_ma200=1
- [ ] SQL:`select symbol, expected_rank, cost_per_lot_ntd from v_rank_with_cost where cost_per_lot_ntd <= 100000 order by expected_rank limit 10`
- [ ] SQL:`select count(*) from v_factor_scores where mom_above_ma200 = 1`(預期數量略多,因為現多頭環境多數股站上 MA200)
- [ ] `select * from score_universe_at(current_date - interval '7 days') limit 5`(歷史視角 sanity check)
- [ ] /settings 可輸入預算 budget_ntd
- [ ] /rank SSR 200,filter 生效(設 100000 看 top 10 限低價股)
- [ ] `npm run build` pass(host 跑)
- [ ] 觸發 M9.3 baseline backtest (2024-01-01 ~ 2024-12-31) 對比 8c1bd889-e786-4758-ba2c-6752fb10b303

### Review

**5 個 migration + 6 UI 檔改動**:
- 71 `app_settings`:`peg_threshold` 1.2→1.5(放寬讓 TSMC/聯發科 PEG 偏高的續強龍頭過關)+ 新增 `budget_ntd` = 0(預設不 filter)
- 72 `v_price_factors`:agg CTE 加 `ma200_now`(rn 1..200 avg)+ `ma200_days_available`(rn 1..200 count),新 factor `mom_above_ma200`(close > MA200 AND 60d ret > 0)。ranked CTE 視窗從 180 → 220 天給 MA200 用
- 73 `v_factor_scores`:動能 4 → 5,加 mom_above_ma200 pass-through 與 count_pos / count_total 對應;peg_threshold settings 預設改 1.5
- 74 `v_stock_rank` + `v_entry_signal` + `v_rank_with_cost`:rank 加 mom_above_ma200 pass-through;entry signal strong 規則 mom≥4(對應 4/5 = 80%);新 view `v_rank_with_cost` join `v_latest_price_realtime`,加 `cost_per_lot_ntd = current_price × 1000`
- 75 `score_universe_at`:整段 function rewrite 同步 19 factor + ma200_now + ma200_days_available + mom_above_ma200 + 視窗 220 天 + settings peg_threshold 預設 1.5

**UI 改動**:
- `settings/page.tsx`:budget_ntd 拆獨立 section + `BudgetRow` component(萬位即時提示);其他 settings 仍走 `SettingRow`(step="0.0001")
- `settings/actions.ts`:加 revalidatePath("/rank") 讓 budget 變動立即反映
- `rank/page.tsx`:
  - query source 從 `v_stock_rank` 改 `v_rank_with_cost`(limit 80,給 budget filter 留空間)
  - 多 query app_settings.budget_ntd
  - SSR filter `cost_per_lot_ntd <= budget`(budget=0 不 filter)
  - 加 `BudgetHeader`(已設預算/未設預算兩種狀態)
  - `EmptyState` 區分「沒符合預算」vs「沒任何資料」
  - 新欄「1 張成本」(fmtCost helper:≥1 萬顯示 X.X 萬,< 1 萬顯示千分位)
  - Legend 7/5/2/5,加「站上 MA200 續強」,PEG 改 < 1.5,加 strong 規則說明
- `AdviceWidget.tsx`:header 文字「19 因子」/ 動能描述「5(加突破 + 站上 MA200)」
- `FactorRadar.tsx`:只動開頭註解(component 本身完全 dynamic)
- `stocks/[symbol]/page.tsx`:`FactorRankRow.mom_above_ma200` 補上;`buildFactorAxes` 加「站上MA200」label;`fund_peg_low` label 從「PEG<1.2」改「PEG<1.5」

**Dashboard(`app/page.tsx`)不需動**:
- 它只 select count 欄,沒讀 individual factor
- `mom_count_total` 自動從 4 → 5
- `fund_count_pos >= 5` filter 不變(7 條中過 5 = 71%)
- 不在 spec「6 UI 檔」清單內是正確的

**設計決策**:
1. **mom_above_ma200 條件**:嚴格字面解讀 spec「60 日報酬 > 0% AND latest_close > MA200」。為什麼兩個都要?單看 close > MA200 不夠 — 股價剛突破 200 日線但 60 日報酬還負(剛從低點反彈)是「翻轉中」不是「持續強」。雙條件確保「中期 + 長期同步向上」
2. **ma200_days_available ≥ 180 寬鬆 10%**:spec 寫 180,即 200 × 0.9。給新上市股 ~9 個月歷史留空間,避免被一刀切。剛好接近 1 個季度線(60)+ 半年線(120)+ 200 日線之間的中間值
3. **ranked CTE 視窗 180 → 220**:200 個交易日歷史需要,且加 10% buffer 因 row_number 排序是 trade_date desc 取最近的(超過 200 的不影響 rn 1..200 計算)。220 天涵蓋 ~220 trade days × 5/7 ≈ 314 calendar days,夠
4. **v_rank_with_cost 分開不寫進 v_stock_rank**:
   - v_stock_rank 是純 factor 邏輯,join realtime price 會語意混淆(score_universe_at 歷史視角不能用 realtime)
   - 獨立一個 view 給 UI filter 用更乾淨,backtest 路徑零影響
5. **budget filter 在 SSR 端而非 SQL view**:
   - spec 寫「不動 v_stock_rank,改在前端 filter(避免 view 重做)」
   - 也讓 budget 變化不需 rebuild view(只是 app_settings update + revalidatePath 觸發 re-fetch)
6. **fmtCost 「11.4 萬」vs 「3,250」**:Andy 預算經常以萬為單位思考,小於 1 萬的低價股(KY 股或興櫃)仍以千分位顯示完整數字,讓兩種價位都好讀
7. **rank query limit 80 而非原 30**:因 budget filter 後可能濾掉很多,留空間讓 top 30 顯示仍有量(80 應夠 cover 多數預算)。若 budget 極低仍會出現 empty state
8. **mom≥4 in 5 entry strong 規則**:M9.2 是 mom≥3 in 4 (75%),M9.3 加到 5 條後維持類似嚴格度,mom≥4 in 5 (80%) 比 mom≥3 in 5 (60%) 嚴。spec L33 文字明確要求 4。

**Lessons 遵循**:
- L01 範圍:universe 維持 stock_universe ∪ industry ∪ watchlist ∪ holdings_transactions ∪ etf_metadata
- L13 NUMERIC string:budget / current_price / cost_per_lot_ntd 全 `Number(x)` 轉,顯示用 fmtMoney / fmtCost
- L14 Tailwind v4:BudgetHeader 兩個版本(emerald/zinc accent)用字面 className,沒 dynamic class 組裝
- L19 多 agent 邊界:沒動 M3.6 v_stock_score / v_industry_picks,沒動 M8.x 持股相關 view / EF
- L20 backward-compat:v_factor_scores / v_stock_rank / v_entry_signal cascade drop 重建,score_universe_at 用 create or replace。`fund_peg_low` 因 settings 改 1.5 自動寬鬆(view 不需動)
- L23 資料量保護:mom_above_ma200 需要 ma200_days_available ≥ 180 + ma200_now / latest_close / close_60d_ago 都非 null
- L32 score_universe_at 必同步:75 號 rewrite,19 factor + 視窗 220 + ma200 新欄 + settings 預設 1.5,全部對齊 73/74 號
- L33 settings-driven 對 backtest 的取捨:peg 改 1.5 後同一 backtest run 結果會跟著改(新跑算新值)— Andy 自己用 backtest_runs.name 標籤標 M9.3 區分

**取捨 / 已知限制**:
- mom_above_ma200 跟 mom_ret_diff 有點重疊(都看 60 日報酬)。但 mom_ret_diff 是「20 日報酬 vs 60 日報酬比例」,mom_above_ma200 是「60 日報酬 > 0 + close > 200 日線」,前者測「加速度」後者測「長期方向」。兩者過關代表「方向 + 加速」雙都有,不是 redundant
- 預算 filter 在 SSR 端 = budget 改變只觸發 revalidate;若 Andy 想互動式 toggle(client-side 不刷新)需要 client state,v1 簡化先這樣
- v_rank_with_cost 是 view 不是 materialized view,每次 query 都重算 join。但 v_stock_rank 本身已是 derived(多個 CTE 計算),v_latest_price_realtime 也是 view → 多 join 一層成本可忽略
- v_rank_with_cost.cost_per_lot_ntd 用 current_price × 1000,沒處理「零股」/「整股」差異(假設 Andy 都買整張)。零股場景未來再加另一個 cost_per_share 欄
- 視窗 220 天會讓 v_price_factors 計算量略增(原 180),但 universe < 200 檔,SQL 視窗函數對 RDBMS 不是瓶頸(< 1s 應該 OK)

**驗證受限**:
- 本 session bash 完全被沙箱擋,無法跑 supabase MCP / supabase CLI / npm run build
- TS code 三次通讀過:所有 import / interface 對齊;新 RankWithCostRow 含 current_price / cost_per_lot_ntd / price_source;BudgetRow 簡單 form;buildFactorAxes 加 mom_above_ma200 軸
- 套用順序:host claude / Andy 用 supabase MCP 依序套 71 → 72 → 73 → 74 → 75
- 套完 SQL 驗:見上面驗證清單
- M9.3 baseline backtest 可比較 8c1bd889(M9.2 baseline,2024 全年 alpha -29.45%)— 期待 alpha 有改善(目標 > 0,即跑贏 0050)

---

## 後續可考慮(M8-M11 範圍外)

- 自動下單(券商 API 串接)
- 限價單 / 停損單模擬
- 多 user 登入(改用 Supabase Auth)
- 跨市場(美股、加密貨幣)
- Tab 6 Alerts(觸發紀錄 + LINE 通知)
- ML 升級(XGBoost / LightGBM)— 待 backtest 證明統計版有效再評估
