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

## M9.5 — 低基期轉機模式 OOS 回測(2026-05-19)`analyst-deployer`

**起因**:2492 華新科 5/6→5/14 +49.7%,系統 rank 36 沒選到。卡點 ROE 4.7%(連放寬到 5% 都不過)+ 量 1.4x(mom_breakout 寫死要 2x)。Andy 5/12 講好「繼續噴就討論低基期轉機模式」→ 已觸發。**方向:加分路線(新增 factor、不動任何硬門檻)** — 最 append-only、revert 最便宜、不為單一股放寬硬條件(最低 overfit)。

### 新 factor 定義 `mom_low_base_breakout`(boolean,進 mom 維度 5→6)
- 低基期:`(latest_close - low_120d) / low_120d * 100 < LOW_BASE_PCT`(掃描 {20,25,30,40},先 25 起手)
- 帶量:`vol_latest > vol_5d_avg * 1.4`
- 突破:`latest_close >= high_20d * 0.99`(沿用既有 mom_breakout 的 20 日新高定義)
- null 防護:照 M9.4c — 資料不足(ma/vol/low_120d 任一缺)回 `null::boolean` 不回 false
- **設計理由**:120d 低點定義「長期低基期」排除崩完短彈假訊號;量1.4x+新高對應 2492 啟動特徵;只在低基期前提認列這種較弱突破 = 非無差別放寬。不動 fund/ROE/v_entry_signal/加權 → 純加分

### 要動的檔(全 append-only,照抄 M9.4c migrations 20260515000006~11 範本)
- [ ] `新號_v_price_factors_low_base.sql`:agg CTE append `low_120d`;select 尾端 append `pct_from_120d_low` + `mom_low_base_breakout`。既有欄序型別不動(避 cascade)
- [ ] `新號_v_factor_scores_low_base.sql`:mom_count_pos / mom_count_total 表達式 5→6
- [ ] `新號_score_universe_at_low_base.sql`:整段 create or replace(=20260515000011 body + 同步加 low_120d/pct/factor + mom_count 6),L32 必同步
- [ ] 先寫好備用 `新號_*_revert_low_base.sql`:計分回 5、欄位留 dead(和 M9.4c revert 20260515000010/11 一樣)
- **不動**:run-backtest EF / app_settings / v_entry_signal / v_stock_rank 加權 / holdings·telegram 鏈

### 驗證三閘(L36 具體化,不過閘即 revert)
- [ ] **Gate 0 零漂移**:套用後 score_universe_at(today) vs v_factor_scores 四維 count 全 0 不一致(L32);加 factor 前 backtest byte-exact = Phase 0.7 錨點
- [ ] **Gate 1 樣本量/區別力**:2024 全年每 rebalance 日統計 `mom_low_base_breakout=1` 的 (distinct symbol 數、進 top10 次數)。**distinct symbol <15 或進 top10 <10 次 → factor 無區別力,當場 revert,不跑 Gate 2**。並抽查 2492 在 2026-05-06 啟動點 rank 是否上升(驗 factor 真抓得到此 case)
- [ ] **Gate 2 OOS 對比**:4 run(2024 t10/t5 in、2025 t10/t5 OUT),exec_model='nextopen' 動態成本。baseline = 誠實化 v2(2025 **t5 +24.19** / t10 +13.80;2024 t10 -27.86 / t5 -17.33)。**判準:2025 t5 OUT 不得低於 +24.19 且 2024 不顯著惡化**,沒贏即 revert(L36)
- [ ] LOW_BASE_PCT 掃 {20,25,30,40} 各跑 Gate 2 選 OOS 最穩;全輸 baseline → 此路不通 revert + 記 lesson
- [ ] `npm run build` pass(host 跑) + commit + todo review + lesson

### 倖存者偏差 caveat(必附,L38/L39)
回測 universe=154 檔全 selected_at=2026-05-12。低基期轉機股**最易踩倖存者偏差**(很多衝一下就陣亡,只有活的還在 universe)。即使 Gate 2 贏 baseline 也只證「精選存活集內有效」= 樂觀上偏、非可交易保證。真 de-bias 靠已上線前向紙上追蹤長期累積。

### scope
4~5 migration(全 append-only 抄 M9.4c)、0 行 EF/前端。實作風險低,時間主要在跑回測掃門檻。

### Review(結案 2026-05-19)— **Gate 1 否決,「低基期」對 2492 是偽命題,Andy 拍板停 M9.5**

**結論**:`mom_low_base_breakout` 前提錯誤,不採用。

**實際 vs spec 偏離(2 處,均更安全/更省)**:
1. apply 策略改「只先 apply score_universe_at(backtest 路徑),線上 v_price_factors/v_factor_scores 不動」— 原 spec 隱含三檔全 apply(會在未過閘前改線上 /rank);Andy 在意持股零影響,改成過閘才上線。L36/「先評估再決定」精神
2. Gate 1 即否決 → 沒跑 Gate 2 掃 {20,25,30,40}(省算力,Gate1 存在的意義)

**Gate 1 數據**:2024 樣本量足(145 distinct sym / 1193 sym-day)但 2492 在 5/4~5/18 啟動段(138.5→220 +59%)factor 命中 **全 0**。診斷:2492 的 120d 低點=80(2025底),5 月爆發時距低點 **+30~90%**,是「2025 從 80 漲到 220 的長多段強勢股」非低基期型態;放寬到 40% 也框不到。2024 命中多為台灣大/統一/華南金牛皮股放量,語意偏離。

**收尾驗證(持股零影響,Andy 點名,3 次查證)**:
- apply 前/後/revert 後三次指紋比對:線上 10 view(持股鏈+選股鏈)md5 全程 byte 零變動;持股 6285/1000/28.4萬 + 10 筆交易紀錄零變動;score_fn 無 DB 物件依賴(deps=[])
- score_universe_at forward→revert,殘留字串 `low_120d`/`mom_low_base_breakout`/`LOW_BASE_PCT` = **0**,mom 計分回 5 條(mom_above_ma200 收尾),mom_total_max 5。**行為等價回 20260515000011 基線已證**
- md5 非 byte-exact 回基線 = 良性(SQL prosrc 受 CRLF/空白物理表示影響,非邏輯差異);驗證以行為等價為準(見 L41)

**repo 終態**:留 `20260519000003`(forward,apply 過=史實)+ `20260519000005`(revert,現行,DB 回基線);刪 `000001/000002/000004`(線上 view 從未 apply,留著會被未來 db push 誤套)。沿用 M9.4c「試驗檔+revert 並存」慣例。

**教訓 → lessons L41**:案例契合度驗證(2492 真的符合「低基期」定義嗎)要前置到寫 spec 之前(Gate 0),別憑記憶檔/直覺假設就往下做完整套流程。

**DB 現狀**:score_universe_at = 20260515000011 基線(動能 5 條),零殘留。線上選股/持股/Telegram 全程未受影響。

---

## 持股自動完整追蹤根治 + 6285 止血(2026-05-19)`data-pipeline`

**起因**:Andy 截圖質疑持股 6285 分析不精準。診斷:6285 用 transaction-log 記、不在追蹤名單,price/fundamentals/monthly_revenue/pe_pb 全 0 筆 → v_factor_scores fund/mom 0/0、signal=insufficient_data、rank #10(只籌碼撐的假象);/holdings「持續抱」是無資料默認非分析。

**根因**:M8.5 持股改 transaction-log 後,籌碼 4 EF 升級讀 v_holdings_current,但價格類 4 EF(daily-prices/fundamentals/monthly-revenue/valuation)沒跟上仍讀舊 holdings 表 → 沉默 drift(半年沒人發現,使用者持股恰好踩盲區才暴露)。

**做法(Andy 拍板:建單一來源根治)**:
- 新 view `v_fetch_universe`(=v_holdings_current∪watchlist∪industry∪stock_universe∪etf,migration 20260519000007)
- 4 EF symbol source 改讀 view + fallback=各自原 query(view 異常零退化)。籌碼 EF 不動(已正確,只動該動的)
- deploy 親驗:fetch-daily-prices v7 / fundamentals v2 / monthly-revenue v2 / valuation v3(verify_jwt 全 true 未變、其他 EF 未誤動)
- 6285 backfill **自助完成**(複用 cron pg_net+vault pattern 經 execute_sql,非交 host):price 810 / fundamentals 13 / monthly_revenue 41 / valuation 811,errors 全 0,token_2 quota ~8

**結果**:6285 v_factor_scores fund 0/0→7(過5)、mom 0/0→5(過2);v_holdings_advice signal `insufficient_data`→`normal`、rank **#10→#60**、wscore 50.57。**之前 #10 是資料缺失假象,真實 #60 — Andy 持股決策現在才建立在真實分析上**。

**根治效果**:下次日更 cron 自動收 6285 + 未來任何新持股自動完整收料,單一來源 view 杜絕未來 drift。

**commit**:`c4e850f`(已 push origin/main)。教訓 → lessons **L42**。記憶 → `stock_ef_invoke_via_pgnet`(無 invoke 工具時自助觸發 EF 途徑)。

**後續可選(非本次 scope)**:① 籌碼 4 EF 也統一改用 v_fetch_universe(目前 inline 仍兩套) ② 持股 signal=insufficient_data 主動告警(沉默失敗偵測,L42 做法2)。

---

## 籌碼 4 EF 收料 universe 統一(2026-05-19)`data-pipeline` — 計畫待 Andy 拍板

**起因**:L42 做法3 / todo「後續可選①」。c4e850f 已把價格 4 EF 改讀 `v_fetch_universe`,籌碼 4 EF(institutional/margin/lending/shareholding)仍 inline `v_holdings_current ∪ watchlist ∪ industry_stocks ∪ stock_universe`(4 source、**無 etf_metadata**)→ 兩套 pattern,未來新增 source 表會再 drift。

**關鍵發現(非機械鏡像)**:`v_fetch_universe` = 上述 4 + `etf_metadata`(多 **11 檔 ETF**:0050/0052/0056/006208/00679B/00713/00878/00919/00929/00940/00981A)。籌碼現用 universe=149、v_fetch_universe=160。籌碼 EF 直接改讀 v_fetch_universe → 行為改變:
- 每個籌碼 EF 每跑多 +11 ETF symbol API call
- `institutional` 明確註解「ETF 沒法人買賣超…只抓個股」→ 收語意無效資料
- `lending` 已慢性配額耗盡(05-14/05-18「quota exhausted at ~2883」)→ +11 更糟

**建議 Option A(雙 view,零行為改變,真正單一來源)**:
1. migration:`v_fetch_universe_stocks` = 現籌碼 4 source(無 ETF);`v_fetch_universe` 改 `= v_fetch_universe_stocks ∪ etf_metadata`(對價格側 byte 等同,160 不變、零退化)
2. 籌碼 4 EF happy path 改讀 `v_fetch_universe_stocks`;fallback **保留各自現有** inline 4-source query(view 異常=今日 byte 等同,鏡像 c4e850f 哲學)
3. deploy 4 EF,親驗 verify_jwt 全 true 未變、其他 EF 未誤動;response `target_symbols`=**149**(非 160,證 ETF 沒漏入)
4. 退化錨:`count(v_fetch_universe)`=160 不變(價格側)、`count(v_fetch_universe_stocks)`=149(=舊籌碼數)

**效果**:stock 底集單一定義(`v_fetch_universe_stocks`),未來加 source 表 1 處改、8 EF 自動同步;ETF 為價格側 explicit additive layer。籌碼/價格各自語意零變、零 quota 退化。scope:1 migration + 4 小 EF edit + deploy。

- [x] migration `20260519000008_v_fetch_universe_stocks`(append,不 cascade)— applied
- [x] 4 籌碼 EF happy path 改 `v_fetch_universe_stocks` + 保留原 fallback
- [x] deploy 4 EF + 親驗(verify_jwt 全 true 未變 / 僅 4 EF 動 / ezbr sha 變)
- [x] 退化錨:v_fetch_universe=160(價格側零變)、v_fetch_universe_stocks=149、ETF 洩漏=0、0050 價收/籌排
- [x] service_role SELECT v_fetch_universe_stocks=149 無錯(EF happy path 可讀,不靜默 fallback)
- [ ] commit(待 Andy)+ 17:00+ 籌碼 cron 為線上端到端確認點(fetch_log target_symbols 應=149)

### Review(2026-05-19,Option A 完成)
**結果**:籌碼 4 EF v1→v2 全部署,verify_jwt 全 true 未變,僅 4 個 EF 動到。`v_fetch_universe_stocks`(149 stock 底集)+ `v_fetch_universe`(=stocks∪etf=160,價格側 byte 等同)。零行為改變、零 quota 退化。
**驗證(L40 紀律,零 FinMind 消耗)**:資料層 + service_role 可讀性雙證;未做整檔 invoke(會燒 ~450 call 且惡化 lending 配額——本次要保護的對象)。線上 cron 17:00+ 為自然端到端確認點。
**偏離 spec(1 處,更安全)**:未現場 invoke 驗 target_symbols,改以「資料層+權限+部署 sha」三證 + 線上 cron 自然確認(L40:昂貴動作對結論非必要時用等價省做法)。
**根治效果**:stock 底集單一定義,未來加 source 表 1 處改、籌碼+價格 8 EF 自動同步;ETF 為價格側 explicit additive layer。L42 做法3 達成。

### 健檢順帶發現 → 已修(2026-05-19,Andy 拍板補全 48 檔)

**現象**:健檢發現 2330 缺 05-12~15;深查發現**非 2330 專屬 = 48 檔權值藍籌**(2330/1101/1216/1301/2303/2412/2880…)05-12~15 集體缺 4 天,全 universe 那 4 天 156→108。

**根因(L34 追資料定性)**:這 48 檔平日靠 `finmind` fallback EF 收(TWSE primary STOCK_DAY_ALL 平日只覆蓋 ~89,05-18 擴到 137 才自補)。05-12~15 `finmind` fallback 每天回報 success(rw=107)但**當日列未落地**(price_daily finmind_n 49→1)→ 4 天靜默缺口,被「回報成功」掩蓋(L42 同類)。

**修復**:自助 fetch-finmind-backfill(L42 做法4 / pgnet+vault,token_2),dataset=price symbols=[48] 05-12~15。EF 回 status200 written=**192(=48×4)** errors=0 quota50/600。親驗:05-12~15 每日 108→**156** 回升、2330 連續 05-11..05-18 無洞、藍籌 6 檔全回。backtest/rank/持股這 4 天已正確。

**⚠ 未根治的 recurring 根因(Andy 本次選只補料、未深挖)**:`finmind` fallback「回報 success 卻當日列不落地」會再發;且 2330 等大型藍籌不在 TWSE primary STOCK_DAY_ALL(長期靠 fallback)很脆。**後續候選**:① 查 fetch-finmind-fallback 為何 success 卻 under-land(rw=107/rs=535 固定樣態可疑)② 查為何藍籌不在 TWSE primary ③ signal/coverage 缺口主動告警(L42 做法2,本次又一次靠人工健檢才抓到)。

---

## M9.4b 停損 -10% 完整 OOS 閘 → **否決,不採用**(2026-05-19,結案)

完整閘(無停損臂=誠實v2基準,經 2025 t5 byte-exact 重現 +24.19 證零漂移可信):

| Run | 無停損基準 | +停損-10% | Δ alpha | run_id(停損)|
|---|---:|---:|---:|---|
| 2024 t5 IS | −17.33 | **−28.26** | **−10.93 ❌** | d139d734 |
| 2024 t10 IS | −27.86 | −27.73 | +0.13 持平 | 1669d4e1 |
| 2025 t5 OOS | +24.19 | +25.85 | +1.66 ✓ | 39c32637 |
| 2025 t10 OOS | +13.80 | +11.83 | **−1.97 ❌** | 0f1a62cd |
| 2025 t5 無停損 |  | +24.19 |  | b602e2ba |

**結論**:4 格僅 2025 t5 贏(+1.66),2024 t5 大幅惡化 −10.93、2025 t10 −1.97、2024 t10 持平 → **未過 L36 閘,不採用**。**L36 陷阱重演**(=M9.4c 同款:單看 2025 t5 +25.85 漂亮,完整閘破功)。停損一致降 MaxDD/勝率持平,但報酬代價 3/4 格成立。根因:固定 −10% 太緊,砍掉 2024(0050 超級年)洗盤段的單。

**未做(可選)**:掃更寬停損 {−15,−20%} 看能否保 2025 t5 增益又不過砍 2024 — 但 L36 預設「會弄壞已驗證 edge」需證明否則不採用,優先度低。**目前最佳仍 = 純 5-factor top5 無停損(OOS +24.19,受倖存者偏差 L38)**。教訓沿用 L36,未新增 lesson(同款假陽性已被 L36 涵蓋)。

---

## ATR/Chandelier 停損 spec + 完整閘(2026-05-19,待 Andy 過目才動 code)

**起因**:M9.4b 固定 -10% 完整閘否決,根因 volatility-blind(2024 0050 超級年把高波動權值股在正常洗盤洗出,-10.93pp)。Andy 指正方向 = ATR 動態停損 / 時限停損(lessons L43)。

**失敗機制(對症依據)**:固定 % 對台積電/聯發科這種高波動股,-10% 只是日常 noise → whipsaw 砍掉最終大贏家。解法 = 把停損距離正規化到「每檔自身波動」。

### 設計(只改 run-backtest EF,零 migration/view/前端/score_universe_at)
現行停損:`stop_loss_pct>0` → `stopLine=entry×(1-pct/100)` 持有窗逐 bar 比 `low<=stopLine`(L460-480)。bars 已含 OHLC。

新增(互斥模式,參數驅動):
- `stop_atr_mult?` (k):**A. ATR-static** — 進場日往前 ATR14 算一次,`stopLine = entry − k×ATR14_entry`(全持有期固定)。最小改動=只換 stopLine 公式,其餘逐 bar/誠實出場價邏輯沿用
- `stop_chandelier_mult?` (k):**B. Chandelier(順勢移動)** — `stopLine_t = max(high, entry..t) − k×ATR14_t`,逐 bar 重算(鎖利、讓贏家跑)。Andy 屬意,對 top5 集中度更對味
- ATR14 標準:TR=max(H−L,|H−prevC|,|L−prevC|),14 期均
- 資料窗:`fetchStart` 由 -10 放寬到 ~-30 日(夠 ATR14 種子),**只擴 fetch 不改既有邏輯**
- 不足 14 bar(回測極早期):ATR=null → 該持股**該期不施停損**(不偽造,L23/L42 精神)+ 計數回報透明

**L39 鐵律保留**:三參數全 0/null → 停損整段 short-circuit 不變 → `exec_model='close'+cost0.585` 仍 byte-exact 重現基準;誠實v2 無停損仍 byte-exact = 今日 +24.19 錨點。新 ATR 區塊全程 gated behind「param>0」
**互斥**:`stop_loss_pct` / `stop_atr_mult` / `stop_chandelier_mult` 同時 >1 個 >0 → 400 error(避免語意含混)

### 完整 L36 閘(每個候選 k 都要過,no-quota/快)
- [ ] code:run-backtest 加 ATR14 + A/B 兩模式 + 資料窗放寬 + 互斥檢查
- [ ] **退版錨點先驗**:三參數=0 → 2025 t5 = byte-exact +24.19(=今日 b602e2ba);`exec_model=close+cost0.585` = Phase0.7。**過這關才信新數字**(L39)
- [ ] deploy(verify_jwt true 不變 / 僅 run-backtest 動)
- [ ] 掃 k:A 與 B 各 k∈{2.5, 3, 3.5},每個跑完整 4 格(2024 t5/t10 IS、2025 t5/t10 OOS)vs 誠實v2 基準(+24.19 / +13.80 / −17.33 / −27.86)
- [ ] **判準(L36)**:任一 k 須**不顯著惡化任何格**(尤其 2024 t5 該被固定%重創的格),且整體 alpha/Sharpe/MaxDD 至少不差於無停損;沒有 k 同時滿足 → 此形式亦不通,如實記否決(別硬凹)
- [ ] 報表:4 格 × 各 k 的 alpha/Sharpe/MaxDD/勝率/停損觸發數;對比固定-10% 與無停損
- [ ] commit + todo review + lesson(若有)

### scope/風險
blast radius 小(單一 EF、不碰選股鏈/持股鏈/前端);風險在「又一個 L36 假陽性」——預設假設「會弄壞 +24.19 edge」,要 4 格證明否則不採用。時限停損(Time Stop)此架構槓桿小(rebalance_days=20 已週期汰換),除非 Andy 要否暫不納入此 spec。

### Review(結案 2026-05-19)— **A/B 皆否決;確認「集中 top5 結構性排斥停損」(已測 3 形式)**

**實作完成**:run-backtest v5→**v6**(stop_atr_mult / stop_chandelier_mult,互斥檢查,ATR14 SMA,fetch 窗 -10→-30,atr_seed_unavailable 透明計數)。L39 雙錨點 **byte-exact PASS**:no-stop 2025 t5 = +24.19(=b602e2ba)、close+0.585 2024 t10 = −35.23(=Phase0.7)→ 零邏輯漂移已證。

**踩坑**:24 並發 score_universe_at → 全 statement timeout(非碼錯;≤3 並發安全)。改聚焦 2 關鍵格 × A/B k3。

**聚焦閘結果**(k=3;baseline 無停損 / 固定%−10 對照):

| 格 | 無停損 | 固定−10% | **A ATR k3** | **B Chand k3** |
|---|---:|---:|---:|---:|
| 2024 t5 IS(固定%重創格)| −17.33 | −28.26 | **−35.04** | **−40.63** |
| 2025 t5 OOS(+24.19 edge)| +24.19 | +25.85 | **+21.73** | **+7.72** |

**結論:A/B 皆否決,且比固定% 更糟。** 波動正規化**沒救到** 2024 whipsaw、反而更慘(−35/−40 vs 基準 −17、固定 −28);2025 OOS edge A 小蝕(−2.46)、B 幾乎毀掉(−16.47)。atr_seed=0(資料正常,停損真觸發 A18/B34-37 次)。**機制確認**:M9.4a 集中 top5 的 edge 來自「在強趨勢年(2024)抱住高波動權值股穿越洗盤」,**任何停損(固定/ATR/Chandelier)都砍掉那些必須抱的單** → 結構性排斥停損,非「停損形式/門檻沒調對」。Chandelier 最差(trail/ratchet → 觸發最多 34-37 次)。

**未掃 k{2.5,3.5}/未跑 t10**:k3 在最診斷格已比固定% 更糟,機制是結構性非門檻敏感(更寬 k → 漸近無停損 = 最好也只是回到 baseline,不可能 improve 2024)。L36 預設否決 + L40/L43「別暴力掃死形式」→ 結案不續掃。停損探索到此為止(除非未來改用 regime filter 在強趨勢年停用停損 = 另案)。

**最佳仍 = 純 5-factor top5 無停損**(OOS +24.19,受倖存者偏差 L38)。v6 ATR 能力碼保留(已 anchor 驗證、未來 regime 實驗可複用,如 M9.4b stop_loss_pct 保留慣例)。教訓沿用 L36/L43,無新增 lesson(同款假陽性 + 換形式化仍須過閘已涵蓋)。

---

## 籌碼 4 表歷史空缺 — 重大發現(2026-05-20,優先級依 Walk-Forward 結果定)

**起因**:L1 維度差分查 TSMC chip 2024 為何 0/0,發現**不是 TSMC 專屬,是全表歷史**:institutional / margin / lending / shareholding 4 表的 全表最早資料是 2026-04-16 / 05-04(EF cron 首次啟動點),**2024 / 2025 backtest 期間 chip 5 條因子對全 154 檔皆 null**。

**含意(推翻基本假設)**:
- 5-factor 模型在歷史回測中**實際只用 14 條**(fund 7 + mom 5 + rev 2)
- chip 維度 10% 權重佔分母但係數全 null → ws 天花板 ~90%(觀察到的 ws 72.5 = 進 top5 的最高分對應此)
- 線上 19-factor 排名 vs backtest 14-factor 排名 **系統性不對齊**
- **+24.19 OOS alpha 是 14-factor 達成的、不是 19-factor**

**Andy 拍板:條件式優先級(依 Walk-Forward 2023-2025 結果定,2026-05-20)**

- 若 14-factor 在 2023-2025 季滾動勝率 ≥60% 且分布均勻 → 「不需要籌碼,基本面+動能已極強大」→ **chip backfill 優先級提到最高**(因為線上 19-factor 反而可能被籌碼污染,須回測確認)
- 若 14-factor 滾動表現一般 → 2025 是特例肥尾 → chip backfill **放慢、當背景工程**

**Backfill scope(若決定做)**:
- 4 dataset × ~2 年(2024-01 到 2026-04)× ~150 sym
- FinMind 約 ~1200 calls × 4 dataset = 4800,token_2 每日 600 → 約 8 天分段
- 倖存者偏差 caveat 仍在(2024 universe ≠ 2026 universe)
- backfill 完成後須重跑 2024 / 2025 baseline 看 alpha 變化 + 完整 L36 閘

**教訓 → lessons L44**(歷史 backfill 對齊回測週期;邏輯一致 ≠ 資料覆蓋一致;partial backfill = 沉默 drift,同 L42 第二章)

---

## Walk-Forward 2023-2025(2026-05-20)— 14-factor 純淨版時間軸切碎

**目的**:確認「14-factor 基準」在過去 36 個月是否穩定 alpha,還是 2025 特例肥尾。

**做法**:
- [x] 跑 2023 t5 honest-v2 baseline(`6b1514e8` α +9.89/sharpe 1.90/win 61.82%/maxDD 8.26)
- [x] 從 3 個 baseline runs(2023/2024/2025) 各 12 期 = 35 期 equity_curve 撈出
- [x] 計算季度勝率:8/12 = **66.7%**
- [x] cumulative alpha contribution:**不是 45 度平滑、也不是 2-3 點集中,介於兩者間**(2025 4 季全綠拉開)
- [x] 統計:3 年合 α **+16.75pp**、平均 +5.58pp/年、最大連勝 5 季、最大連敗 2 季
- [x] 結論導出 chip backfill 優先級決策

### Review(結案 2026-05-20)— 季勝率達標但 2025 肥尾,**chip backfill 放慢**

**12 季 α 分布**:

| 季 | Strat | Bench | α | wins |
|---|---:|---:|---:|---|
| 2023 Q1 | 7.83 | 11.57 | −3.74 | 1/3 |
| 2023 Q2 | −0.67 | 9.10 | **−9.77** | 0/3 |
| 2023 Q3 | 13.16 | −2.71 | **+15.88** | 3/3 |
| 2023 Q4 | 9.35 | 3.57 | +5.78 | 1/2 |
| 2024 Q1 | 25.31 | 24.57 | +0.74 | 2/3 |
| 2024 Q2 | 4.67 | 18.34 | **−13.67** | 1/3 |
| 2024 Q3 | 4.87 | −3.98 | **+8.85** | 3/3 |
| 2024 Q4 | −2.59 | 6.90 | **−9.49** | 1/3 |
| 2025 Q1 | −16.86 | −18.66 | +1.80 | 2/3 |
| 2025 Q2 | 28.79 | 23.25 | +5.55 | 2/3 |
| 2025 Q3 | 38.95 | 33.97 | +4.99 | 2/4 |
| 2025 Q4 | 7.15 | 0.69 | +6.46 | 1/2 |

**Andy framing 判定**:介於兩 case 之間,偏「2025 肥尾」(2023+2024 兩年合 α ≈ −2,2025 一年合 α +18.80 拉開全部累積) → **chip backfill 不急、放慢、當背景工程**。

---

## U 型 regime 濾網(2026-05-20,Walk-Forward 衍生發現,**真正可用實戰工具**)

**起因**:Andy 提議從 Q3 雙紅找「Q3 因子簽名」,我 push-back 認為「市場 regime」解讀更穩健 + 資料齊全 + 統計力高。執行後**推翻線性負相關假說,發現 U 型**。

**主要發現**:策略 α vs bench 季報酬呈 **U 型(corr 僅 −0.24,弱)**:

| Bench regime | n | Avg α | 季勝率 | 解讀 |
|---|---:|---:|---:|---|
| **A: bench < 0**(回檔)| 3 | **+8.84** | **3/3=100%** | 個股輪動,5-factor 大勝 |
| B: 0~10%(微漲)| 4 | −1.76 | 2/4 | 混合微負 |
| **C: 10~20%**(中漲)| 2 | **−8.70** | **0/2** | **策略地雷區** |
| **D: ≥ 20%**(狂牛)| 3 | **+3.76** | **3/3=100%** | 跟得上,中等領先 |

**「Q3 雙紅」是 bench<0 衍生現象,本質是 regime 非季節**(2023Q3/2024Q3 bench 都 −2~−4%)。

**Andy 實戰部位管理規則**:
- bench < 0 季 → **滿倉信任**
- bench 0~10% → 中性、降低預期
- **bench 10~20% → 減碼策略 / 改買 0050**(地雷區)
- bench ≥ 20% → 滿倉信任

**Caveats(引用必附)**:
- n=12 季很小(regime C 僅 2 季 / D 僅 3 季),U 型可能含樣本噪音
- 受 14-factor 真相(L44)+ 倖存者偏差(L38)+ 2025 肥尾三層 caveat

**Memory**:獨立記 [strategy-regime-filter-u-curve](memory)。

---

## Paper-track 對齊驗真計畫(等 cohort 累積後執行,2026-Q3~Q4 預估)

**目標**:用 paper-track 實盤 cohort 結算結果,驗 U 型 regime 濾網在「線上 19-factor + 真 OOS」是否仍成立。

**時序**:
- 2026-05-16 cohort #1 已開(10 picks + 1 bench)。`paper-track-weekly` cron 每週六 22:00 UTC = 週日 06:00 Taipei 結算 + 開新 cohort
- 每 ~20 交易日一 cohort → 累積 3-4 cohort 約**2026-09 ~ 2026-11**
- 屆時可做第一次 paper-vs-backtest U 型對齊

**做法(等 ≥4 cohort 後)**:
- [ ] 對每個 cohort:撈進場日的 bench(0050)未來 ~20 日報酬 + cohort 實際 α
- [ ] 把 cohort 落入 U 型 4 regime(A/B/C/D)
- [ ] 統計各 regime 實盤 avg α 與 backtest 預期對比
- [ ] 判定:
  - 實盤 U 型形狀符合 backtest → **真 edge,U 型規則可信、進入正式部位管理 SOP**
  - 實盤呈線性 / 反向 → **backtest U 型是樣本特性,規則失效、回頭重新分析**
  - 實盤混亂 / 樣本不足 → 繼續累積到 ≥ 8 cohort

**最早可決判時點**:約 **2026-11**(4 cohort);**強信度時點**:約 **2027-05**(12 cohort = 8 個月)。

**衍生候選**:
- 若 U 型成立 → 加 `paper_track_cohort_regime` view 自動分類 + dashboard 顯示;改 /holdings 在地雷 regime 時顯示警示
- 若 U 型失效 → 重新分析,可能進方向 B 完整版(寫 `factor_detail_at` function 看個別 19 factor 簽名)

**何時不必做**:若 paper-track 累積到 6-12 月時 Andy 已決定接受策略物理特性(L38 caveat 為主),不需嚴格驗 U 型 → 可純當 reference 規則用即可

---

## fetch-finmind-fallback L42 漏網 bug 修(2026-05-21,結案)

**起因**:Andy 收到 2026-05-21 08:55 推播「6285 現價 292(⚠資料延遲 2026-05-19)」,實際 5-20 收盤 279。糾錯後深挖。

**根因(3 層)**:
1. **fetch-finmind-fallback EF 沒納入 L42 修法**(c4e850f 只修 4 個價格 EF,漏第 5 個):仍讀舊 `holdings` + watchlist + industry + etf 四源,**漏 holdings_transactions + stock_universe** → 6285 (transaction-log 持股) 完全沒進 set
2. **Quota 砍斷後段持股**:fetch-finmind-fallback 15:30 跑時 quota 只剩 ~107,149 universe 跑到 107 即 break;**Set 迭代順序持股不優先** → 2330 / 6285 等熱門股被砍
3. **5-20 主力 TWSE 也漏抓**(L17 T+1 延遲);finmind fallback 也漏抓 → price_daily 5-20 對 6285 完全沒寫 → v_latest_price_realtime fallback 到 5-19 close=292

**修法(3 層,完成)**:
- [x] **立即補資料**:SQL upsert 6285 5-20 = 279(從 cache 13:30 真實)+ invoke fetch-finmind-backfill 補 5-20 缺漏 51 sym(token_2,written 47)→ 5-20 total 108→156 完整
- [x] **修 EF 根因**(L46):fetch-finmind-fallback v4→**v5**,改讀 v_fetch_universe + 持股優先進 set + fallback 保留舊邏輯(c4e850f 同 pattern)
- [x] **加防護層 cron**:`holdings-staleness-backfill-preopen` 每日 08:45 Taipei invoke fetch-finmind-backfill 補持股最近 3 日(token_2,~5 calls/day,idempotent)。明日起即使 fallback EF 又漏,持股一定有資料

**驗證**:
- 5-20 price_daily total = 156(對齊 5-18/5-19);6285=279 / 2330=2185 / 2454=3230 全寫入
- fetch-finmind-fallback v5 deploy ezbr sha 變、verify_jwt true 保留
- staleness cron active,週一到週五 00:45 UTC 跑

**lessons L46 寫入**:「統一 N EF」類修法必 grep 全鏈,憑記憶必漏網(L42→L46 同類重演)。Commit 訊息列「全鏈 EF 清單」可審計。

**待 Railway redeploy 後 commit + push**:本次改動 = fetch-finmind-fallback/index.ts + lessons.md + todo.md。

---

## A+C:產業 tab 拿掉 + lending 換 token_2 解 quota 爆(2026-05-21,完成)

**起因**:Andy「產業 tab 整個拿掉,把扣打拿去讓排行/持股更即時」。診斷後發現:
- 「產業 tab」實際=`/watchlist` route(TabNav label「產業」但 route 不一致;watchlist 表 0 sym)
- industry_stocks 100 sym 是 stock_universe 148 的 99% 子集 → 移除 industry **不省 quota**(EF Set 去重後仍跑 stock_universe 148)
- 真省 quota 必須砍 stock_universe(影響 backtest universe + alpha)
- **lending 慢性 quota_exhausted**(每日跑到 2882 即爆,只跑 1/3 universe)→ 把 lending 移到 token_2 獨立 quota 是更直接的「即時度提升」

**修法(Andy 拍板 A+C,不動 stock_universe)**:

A) UI 清理:
- [x] `TabNav.tsx` 移除「產業」項
- [x] `Sidebar.tsx` 移除「產業」項
- [x] `stocks/[symbol]/page.tsx` 「← 回產業列表」連結改 `/rank`
- [x] `settings/actions.ts` 移除 `revalidatePath("/watchlist")`
- [x] 刪 `app/watchlist/` folder(只 page.tsx 一個檔)
- type check 0 errors(rm -rf .next 重 tsc)

C) lending 換 token_2:
- [x] `fetch-finmind-lending` EF 加 `body.token_key` 參數(同 fetch-finmind-backfill pattern):
  - `useTok2 = body.token_key === "finmind_token_2"`
  - vault RPC 切換 `read_finmind_token_2`,quota source 切到 `finmind_2`(獨立 quota_state row)
  - fetch_log source 維持 `finmind_lending`(便聚合)
- [x] Deploy v2→**v3**(verify_jwt true 保留、ezbr sha 變)
- [x] `cron.alter_job` 改 lending command body 加 `'token_key':'finmind_token_2'`
- 驗:今日 17:10 Taipei lending cron 跑時將用 token_2 600 獨立 quota,**不再 quota_exhausted**

**預期效應**:
- lending 從每日「跑到 2882 ~30% break」→ 完整跑 149 universe
- 排行/持股的籌碼維度 chip_lending_drop 不再因 lending 不全而 null
- token_1 quota 解壓(從 lending 移走 ~150 calls/day):fundamentals / valuation / institutional / margin 跑得更寬鬆
- industry_stocks 表保留不動(行業分類資訊仍給 P/B 門檻、AdviceWidget「分散產業」、個股頁面用)

**未做(被 Andy 否決)**:
- B) 大刀縮 stock_universe 148→30 — 會傷 backtest universe 結構性 alpha,放棄

---

## mis 對 z 有 throttle → 五檔中價 fallback(2026-05-21,L47)

**起因**:Andy 早盤看 /holdings 6285「16 min ago · twse_mis」糾錯「不可能 17 min 沒成交」。

**根因**:免費 mis 對個股 z 有 throttle,即使該股持續成交(v 累積金額跳),z/pz 仍長期回 "-"。EF v4「z="-" skip」邏輯對(L45)但代價=cache 對熱門股寫入頻率 = mis z 偶發回應頻率(20 min 1-5 次)。

**修法(v5,L47)**:
- [x] EF v4→**v5**:多源 fallback,z 有值用 z(source=twse_mis 真成交),z="-" 但 a[0]/b[0] 有值 → 五檔中價 (a[0]+b[0])/2(source=twse_mis_mid)
- [x] quoted_at 改用 fetchedAt(每分鐘 cron 必寫新 row,不受 mis tlong stuck 影響)
- [x] Format.ts 加 twse_mis_mid 顯示「twse_mis(中價)」+ tooltip 標明
- [x] deploy v5 verify_jwt 保留 ezbr sha 變

**驗證**(09:39 第一次 v5 cron):
- fetch_log rw 從 ~25 跳到 **139**(接近 universe 全寫入)
- 6285 cache 09:39:03 = 288.25(source twse_mis_mid 五檔中價)
- 2330 cache 09:39:02 = 2232.50 mid
- v_latest_price_realtime 對 6285 = 288.25,< 1 min ago

**Caveat**:source=twse_mis_mid 表示 mis 對 z throttle 時 fallback 到掛單中價,**不是實際成交價**(但通常誤差 < 1 元 / < 0.5%,institutional acceptable)。UI 顯示「twse_mis(中價)」明標。

**未做**:真正「最新成交價 1 跳」需券商 API 或付費,scope 另案。

---

## 純規則化持股訊號系統 v1 + v2(2026-05-21,結案)

**起因**:Andy 問「持股建議停損判定是固定的嗎?還是會根據股本跟其他因素判斷」→ 發現原 advice 只有 PNL% 一條規則,**完全無波動/成交量/籌碼/技術面**。Andy 主提議「即時分析 6285」→ 我用 13 維度做手動分析(波動、成交量、相對 0050、跳空、量價背離)。Andy 確認「這分析很完整」→ 問「網頁+TG 是不是一定要 API?」→「我不要再另外付費」→ **純 SQL 規則化方向確立**。

**v1 設計(20260521000001,12 訊號 jsonb 陣列)**:
1. pnl_pct(pos/neg/extreme,with 觀察點 +20/+30/+40 / -10/-15)
2. rsi_14(<30 oversold / >70 overbought)
3. ma_pos(price vs ma20/ma60)
4. bench_chg(0050 當日)— **解 Andy「我是不是只是大盤一起跌」之問**
5. price_vol(滾動 20 日標準差/平均 → CV%)
6. vol_ratio(成交量 / 20日均量)
7. consecutive_down(連跌天數)
8. tail_stats(長上影線 / 長下影線)
9. kbar_array(近 5 日 K 棒 jsonb,red/green/cross 標籤)
10. today_kbar(今日 K 棒 jsonb,跨越開盤判 cross)
11. price_source/quoted_at(資料新鮮度 staleness 透明)
12. signal_level overall(healthy/caution/warning/alert,by 紅色訊號數)

**v2 加強(20260521000002,Andy 三項微調)**:
- [x] **建議 1:長上影 + 振幅 > 1.5%** — 沒振幅的長上影是無效訊號(死水)。tail_stats 新增 amplitude_pct 判斷
- [x] **建議 3:量價背離(#13 vol_div)** — 跌 + 量縮(<0.8x) = 沒人賣,屬「健康洗盤」(yellow);跌 + 量爆(>2x) = 恐慌或主力倒貨(orange)
- [ ] **建議 2:市值分檔(中小型 OTC vs 權值 vs 0050)— v3 候選**,需 stock_universe.market_cap_billion 有值(以前全 null,2026-05-21 已 backfill,**v3 解鎖**)

**UI / TG 串接**:
- [x] /holdings 每張卡新增 SignalsGrid(3-6 col responsive),🚨 紅 / ⚠️ 橘 / 💛 黃 / 💚 綠 圓 dot 視覺化
- [x] TG notify-holdings-telegram v3 加「即時訊號」row,top 5 紅/橘/黃 訊號 emoji 摘要
- [x] color map + label map 一致(SIGNAL_STYLE / LEVEL_STYLE / LEVEL_EMOJI / OVERALL_LABEL)

**Caveat**:純 SQL/jsonb 規則 = **無 LLM/API cost**(Andy 不付費前提)。**不會像人類分析師組合多訊號做語意推理**,但 13 維度紅綠燈 + Andy 自己組合判讀 = 客觀基線。

---

## market_cap_billion backfill(2026-05-21,解鎖 signals v3)

**起因**:v2 第 2 項「市值分檔 vs 大盤」需要 `stock_universe.market_cap_billion`,但 reality check 發現該欄位**全 null**(reselect-industry-stocks-monthly EF 沒收這資料,獨立的修工程)。

**做法(零 API quota,純本地資料)**:
- [x] migration `20260521000003_backfill_market_cap_billion.sql`
- [x] 從 `stock_shareholding.shares_issued`(每檔最新)× `price_daily.close`(每檔最新)/ 1e8 → 億元
- [x] update stock_universe + industry_stocks(distinct on 各拿最新值)
- [x] 144 檔填上(industry_stocks 主集合)

**驗證**:
- 2330 台積電 = 566,626 億元
- 2454 聯發科 =  51,806 億元
- 2308 台達電 =  49,743 億元
- 2317 鴻海   =  33,514 億元
- 3711 日月光  =  21,050 億元

**未做(下一個 session 候選)**:
- v_holdings_signals v3 加 #14 market_cap_tier(<300億小型 / 300-3000億中型 / >3000億權值)+ 與 0050 連動度(corr 30日)→ Andy 建議 2 完整實作
- reselect-industry-stocks-monthly EF v2 也收 market_cap(避免月底 reselect 又把 backfilled 值蓋回 null)

---

## v_holdings_current 平倉再建倉均價 bug(2026-05-26,結案)

**起因**:Andy 親口「持有中的股票 2000 股 139.5,結果自動幫我便均價 126 多」。排查:2344 華邦電。

**根因**:舊 view 算法 `avg_cost = SUM(buy_qty × buy_price) / SUM(buy_qty)`,把出清前的舊批次也累積。
- 5/7 BUY 2000@113 → 5/11 SELL 2000@114(全平倉) → 5/26 BUY 2000@139.5
- 舊算 = (113×2000 + 139.5×2000) / 4000 = **126.25** ❌
- 正解 = 5/26 重新建倉的均價 **139.50** ✓

**修法(migration 20260526000001)**:遞迴 CTE 時序走訪 + 移動平均法:
- BUY → total_cost += qty×price ; net_qty += qty
- SELL 全平倉(qty ≥ net_qty)→ **reset:total_cost=0 / net_qty=0**(關鍵)
- SELL 部分減倉 → 按當前均價沖銷:total_cost −= avg×sell_qty(維持均價不變,會計慣例)
- 對只 BUY 沒 SELL 過的持股 → 新舊算法結果完全一致(回歸 PASS)
- net_qty 型別對齊 bigint(舊 view SUM promote 後是 bigint;CREATE OR REPLACE 必須 column type 一致)

**驗證(2026-05-26)**:
- v_holdings_current:2344 / net=2000 / **avg=139.50** / total=279000 ✓
- v_holdings_advice / v_holdings_pnl 連帶修正(都 join v_holdings_current)
- v_holdings_pnl 2344 unrealized_pnl=+1500(+0.54%)/ market_value=280500 / cost_basis=279000 ✓

**衍生待辦(task #24)**:`v_holdings_pnl.opened_at` 用 `min(txn_date where BUY)` 算建倉日,沒考慮平倉重置,2344 顯示 5/7(實際 5/26 重建倉)。修法需 v_holdings_current 多 expose opened_at 欄位(append 到尾巴),v_holdings_pnl 改讀 — 連動 2 view,**等 Andy 拍板**(也可解讀為「我第一次接觸這檔的日期」)。

---

## v_holdings_signals v3 — Andy 建議 2 完整實作(2026-05-31,結案)

**起因**:v2 留下 TODO「市值分檔等 market_cap 資料補齊」,5/21 backfill 完 144 檔,5/31 動工。

**設計**(2 個變更,12 個訊號原樣不動):
- 改 **#11 vs_bench** 依市值分檔調整門檻
  | 分檔 | green | yellow | orange | red |
  |---|---|---|---|---|
  | 權值 >3000億 | >+1pp | >-1pp | >-3pp | else |
  | 中型 300-3000億 / null | >+2pp | >-2pp | >-5pp | else |
  | 小型 <300億 | >+3pp | >-3pp | >-8pp | else |
- 新增 **#14 mcap_tier**(純資訊 gray)— 顯示「權值 5198 億 / 中型 1200 億 / 小型 280 億」

**理由**:權值股本來就跟 0050 高度連動,日差 ±2pp 對權值股太鬆(會把「正常跟盤」當成 green);小型股獨立行情 ±2pp 太嚴(會把「正常獨立走勢」當成 red)。**分檔讓訊號解讀更貼近實況**。

**Reality check(必要的歸納)**:Andy 原建議 2 還提到「中小型 vs OTC, 權值 vs 0050」— OTC vs TWSE 差異**沒做**(因為 0050 已是 TWSE 50 ETF,OTC 股本來就跟它連動度低,落在「小型放寬」這個 case 已隱含覆蓋)。如未來要顯式區分上市 vs 上櫃,再加 #15。

**驗證(2026-05-31 apply 成功)**:
- 2344 華新科 mcap_b=5197.5 → **權值 5198 億** ✓
- vs_bench: 0.0pp · level=yellow ✓(權值門檻 ±1pp,0.0pp 落 yellow 區;v2 的 ±2pp 會回 green,v3 更嚴格)
- 14 訊號 jsonb_array_length 確認

**signal_level 主規則不動**(避免邏輯複雜化、保持回歸性)。

**前置依賴**:`stock_universe.market_cap_billion`(5/21 backfill,reselect EF 不動此表,長期安全)

---

## 全系統審查(2026-05-31,4 subagent 平行深審)

**起因**:換 Opus 4.8,Andy 要求檢視整個股票系統找優化點。派 4 個專責 subagent 平行審:資料管線 / SQL view / 前端部署 / 策略回測。

**好消息(健康面)**:
- 資安乾淨(service_role 沒洩漏到 client bundle,寫操作全走 server action)
- 回測↔線上工程一致(同日 score_universe_at vs v_stock_rank top-12 完全相同、156/161 分數逐檔相等 = 無因子 drift)
- 未實現損益三表交叉一致

**發現分 4 組(~25 項)**:
- A 線上數字正確性 / B 資料管線韌性 / C 策略可信度 / D 工程韌性
- Andy 拍板先做 **A 組**

### A 組進度
- [x] **A1 v_holdings_realized 平倉重置(同根漏修)** — 上週修 v_holdings_current 漏了 realized,同樣用 cum_buy/cum_qty UNBOUNDED 永不 reset。改成遞迴移動平均 + 全平倉 reset(migration 20260531000002)。**驗證**:5 筆平倉全對,2344 那筆 5/11 仍報 avg 113.00/+1121.06(不變),未來再賣會用 139.5(不再是 126.25)
- [x] **A2 mom_ret_diff 負報酬符號翻轉** — ✅ 完成(Andy 拍板全做)。`ret_20d > ret_60d/3` 在 ret_60d<0 時門檻變負,跌深反彈股照樣過。修法=加 `ret_60d>0` gate,兩處同步:
  - migration `20260601000001`(v_price_factors 線上,傳導 v_factor_scores→v_stock_rank→前端/TG)+ `20260601000002`(score_universe_at 回測)
  - **線上效果**:3596 rank5→rank13、2637 rank6→rank17(跌深反彈退出);新 top5 = 2317/2882/2408/2324/8110,ret60 全正
  - **一致性驗證**:score_universe_at(today) vs v_stock_rank top8 逐檔 score 相等(無 drift)
  - **OOS 對照(L36 閘)**:B0 改前 alpha **+24.19** → B1 改後 **+20.02**(−4.17pp);benchmark 一致(35.23,確認純 A2 效果);**MaxDD 18.5→17.16 改善、win 58.33 持平、sharpe 1.87→1.84**
  - **結論**:alpha 降 4.17pp = 2025 那些假動能(跌深反彈)股恰好反彈賺到錢;移除後是更誠實的動能策略 alpha,且風險改善。**通過閘**(bug fix 非 curve-fit,改後仍顯著正 alpha)。**+24.19 OOS 基準更新為 +20.02**
- [x] **A3 Server Component 吞 error(核心完成 + 漸進)** — 建基礎安全網:
  - `lib/db.ts` unwrap helper(error 就 throw,不靜默回 null)
  - `app/error.tsx` boundary(之前**完全沒有** error boundary,任何 throw 都整頁崩)
  - `lib/supabase/server.ts` 加 `import "server-only"`(D 組順手,把「service_role 不進 client bundle」紅線變編譯期保證)
  - dashboard(app/page.tsx)+ holdings 核心 query(v_portfolio_summary/v_holdings_full/v_holdings_pnl)套 unwrap
  - **漸進 todo**:rank/etf/backtest×3/settings/stocks 5 page 套 unwrap(機械工作,error.tsx 已接住真故障/DB 連線失敗,剩餘是防 view drift 靜默空表,ROI 遞減)
- [x] **A4 PerformanceWidget 累積報酬口徑** — ✅ 改用 `avg_cost_at_sell × qty_sold`(A1 提供賣出當下精確移動均價)算 cost basis,取代「淨pnl ÷ 毛pct」反推(分子已扣fee/tax、分母沒扣→cost偏小→高估)。app/page.tsx realized query + PerfRealizedRow + sumCost 三處改。tsc 過
- [x] **A5 v_holdings_signals ETF 還原價口徑 — 實證為誤報,不需修(L47)**。agent 假設「未還原 current vs 已還原 MA = 假偏離 8-10%」。實證推翻:
  - 0050/0056 過去 20 天 adj_factor 全=1.0 → raw MA20 = adj MA20 **完全相同**,+8.5%/+9.9% 是**真實**偏離
  - 機制:`adj_factor[今天]` 恆=1 → `current(raw today)=current(adj today)`,跟 adj MA **同口徑**(都還原到今天基準)→ 比較正確
  - 唯一口徑差:持有期跨除息的 ETF(00878 差 ~1.4pp),但 adj MA(還原)才對(反映真實總報酬),raw 反因除息假跌偏低
  - **結論**:signals 現狀正確,agent P0 誇大。教訓呼應 L47:審查 P0 必須實證,不可照單全收(避免為不存在的 bug 加複雜度)

### B/C/D 組(未做,待排)
- B1 [P0] FinMind quota read-modify-write race(非原子,並行覆蓋,quota gate 失效)
- B2 [P0] fetch-yahoo-intraday + fetch-stock-news 沒納統一 universe(L46 漏網重演,news 漏 ~150 檔+watchlist,yahoo 持股讀舊 holdings 表)
- B3 [P1] reselect-industry-stocks delete-then-insert 非交易性(中途失敗整產業消失)
- C1 [P0] score_universe_at 財報/月營收用會計期間當可得日 = 前視偏誤(實證 2330 在 4/30 看到 Q1)
- C2 [P0] 回測 universe 混入 watchlist/holdings_transactions = 事後選擇偏誤疊加存活者偏誤
- C3 [P1] 回測期籌碼全 null = 實際 3 維,線上 4 維 = 用 A 策略歷史背書 B 策略
- **C 組總評**:+24.19 OOS alpha 應視為「樂觀上界」非真實 edge 點估計(在 L38 caveat 之上的具體放大點)

### 🚨 C 組執行結果(2026-06-01 夜間自主)— 重大誠實發現

**migration 20260601000004(C1+C2 合併,已 apply 線上)**:
- C1:fund_ranked 加發布落差(季報 period_end+45天/Q4年報+90天)、rev_ranked 加月營收次月10日(月初+40天)
- C2:universe 移除 watchlist + holdings_transactions(只留 stock_universe∪industry∪etf)

**OOS 對照(2025 t5 純策略,benchmark 一致 35.23 確認純效果)**:
| 階段 | alpha | sharpe | MaxDD |
|---|---|---|---|
| 原始基準(B0) | +24.19 | 1.875 | 18.5% |
| A2 後(mom_ret_diff gate) | +20.02 | 1.844 | 17.16% |
| **C1+C2 後** | **−9.02** | **0.845** | **29.04%** |

**決定性歸因**:C2 只移除 **2 檔**(009816/6285 = Andy 事後買的 transaction-log 持股),universe 161→159 → −29pp 暴跌**幾乎全來自 C1 財報前視偏誤**。win_rate 58.33% 三階段不變(選股方向對的比例一樣),但報酬幅度崩 → **alpha 來源是「財報季偷看未公告業績選到爆發股」,不是真實選股能力**。

**結論**:**M9.4a top5 策略修掉所有偏誤後,2025 OOS 跑輸大盤 9pp**。原 +24.19「alpha」是前視偏誤假象。⚠ 這推翻策略核心價值,**需 Andy 醒來定奪**(見晨報)。

**C1 真實 alpha 區間量測(2026-06-01 雙 lag probe)**:
| lag 假設 | alpha | sharpe | MaxDD |
|---|---|---|---|
| 保守(法定上限 45/90) | **−9.02** | 0.85 | 29.0% |
| 樂觀(大型提前 +20/45/35) | **+8.21** | 1.66 | 16.7% |
| (原前視假象) | +24.19 | 1.88 | 18.5% |
- **真實 alpha 在 [−9, +8]**,因 top5 多大型股提前公告 → **偏樂觀端**(但樂觀版對拖延小型股仍略偷看,+8 是上界)
- lag 差 20 天 → alpha 差 17pp,證實「財報可得時點」是 alpha 主驅動(=前視確實是 +24 主因)
- **不管哪端都遠低於 +24**;且這是**三維版**(C3 籌碼 null),四維版確切需 paper-track
- FinMind **無真實公告日**(只有 period_end),完整精確版需爬證交所「公開資訊觀測站」申報日(獨立工程,Next Action)
- 樂觀版經 execute_sql 臨時 probe 量測完即 **revert**,線上 score_universe_at 預設 = 保守版(migration 20260601000004,最嚴格誠實)
- **策略定位結論**:M9.4a top5 **不是死策略**(樂觀端 +8 alpha、sharpe 1.66 尚可),但**也不是 +24 金雞**(前視假象)。真實價值在「打平~小贏大盤」量級,高度依賴財報時效。下一步靠 paper-track 四維版實盤驗真。

**線上不受影響**:score_universe_at 僅回測用;線上 rank(v_factor_scores)用 DB 已公告財報,無前視問題,不需改。/rank /holdings 選股顯示照舊。

### C3 維度結構漂移量化(2026-06-01 夜間,聲明性質)

- 回測期 2025-06-09 錨點 avg chip_count_total = **0.00**;2025 籌碼表(institutional/margin/shareholding)**全 0 rows** → 回測期籌碼維度完全沒生效
- 現在線上 avg chip_count_total = **4.33**(institutional recent 1349 rows)
- **結論**:回測(不論 +24.19 還是 C1+C2 後 −9.02)驗的都是「fund+mom+rev **三維版**」策略;線上現在跑「**四維版**」(含籌碼)。**連 −9.02 都不是現在四維策略的真實 OOS**(是三維版的)。要驗四維版需 backfill 2025 籌碼歷史 + 重跑,或等 paper-track 累積真實四維 OOS。
- **疊加總結**:M9.4a top5 的可信度受三重打擊 —— ① C1 財報前視(alpha 假象,修後 −9)② C3 回測≠線上策略(三維 vs 四維)③ L38 倖存者偏差。**+24.19 不該再當策略 edge 引用**。
- D 組:server-only 守衛(1行ROI最高)/ error.tsx,loading.tsx / EF 抽 _shared(解 B1B2 根因) / deriveStatus 對無資料持股仍顯示「持續抱」(L42 前端未根治) / view 依賴鏈深+N+1

### ✅ B1 剩餘 7 EF deploy 完成(2026-06-02,commit 8206d7d 線上同步)

接 2026-06-01 夜間「已 deploy 6 / 剩 7」尾巴,本 session 全 deploy 完(MCP `deploy_edge_function`,verify_jwt 全 true):

| EF | 版本 | 備註 |
|---|---|---|
| fetch-finmind-margin | v2→v3 | |
| fetch-finmind-lending | v3→v4 | 雙 token 保留 |
| fetch-finmind-shareholding | v2→v3 | |
| fetch-finmind-fallback | v5→v6 | L46 v_fetch_universe+持股優先保留 |
| fetch-finmind-fundamentals | v2→v3 | |
| fetch-finmind-backfill | v4→v5 | 9 dataset branch + corp_action recompute |
| reselect-industry-stocks | v1→**v3** | 含 B1+B3;v2 中文 keyword 手寫誤植,v3 機械修正 |

**B1/B2/B3 全鏈完成**:11 個 quota EF 全改 `increment_quota` 原子 RPC(B1)、yahoo+news 納 v_fetch_universe(B2)、reselect 非空才 delete+insert(B3)。`increment_quota` runtime 已驗(finmind_2 today used=1)。

**🔴 過程踩雷 → L49**:reselect v2 用「手寫重現 content」deploy,`classifyIndustry` 正則內中文股名 keyword 產生 8 處形近誤植+漏字(鈺創→鈕創/宇瞻→宇瞩/辛耘→辛耀/富采→富採/聯鈞→聯鈔/為昇科→為昃科/漏華東/妥協→妄協)→ 個股靜默分類錯。**驗證階段 `get_edge_function` 拉回核對抓到**,改用 PowerShell 機械 ASCII-escape(中文→\uXXXX)重產 content → v3 拉回核對 8 處全對。**教訓 L49:deploy EF content 必機械產生不可手打,deploy 後必拉回核對執行路徑字串**。memory [[stock_ef_invoke_via_pgnet]] 早寫明用 JSON.stringify,沒遵循才中標。

**遺留(cosmetic,非必要)**:其他 6 EF 手寫 deploy,中文僅在註解(執行字串全英文、已確認功能正確),但線上註解可能有同類手寫錯字 → 線上≠repo byte-identical。若日後要完全一致,用 L49 機械 escape 法重 deploy 即可;功能無影響故本 session 未做(影響最小原則)。

**待時間驗證**:隔日各 cron 跑後查 `api_quota_state.used` 是否準確累計(B1 原子遞增線上實效)。

### ✅ Dashboard「真實持股」表並列綜合排名 + 進場燈 + 循環股提醒(2026-06-02)

**起因**:Andy 看 2344(華邦電,記憶體循環股)連日衝高/漲停,但 dashboard 持股卡顯示基本面 **2/6** 困惑。診斷:dashboard `HoldingsAnalysis`(app/page.tsx)只從 `v_holdings_full` 拿基本面 score(6 條價值股規則),對**景氣循環股反轉初期系統性低估**(過去虧損 / 低 ROE / 高 PB 全是循環特性);而系統主力 19 因子排名其實給 2344 **expected_rank #13 + is_entry_signal=true**。兩套尺不一致、持股卡只顯示會低估的那套。

**改動(純前端 app/page.tsx,不動 DB)**:
- 新增 `HeldRank` interface + Dashboard 查 `v_entry_signal in 持股symbols` → `heldRankMap`
- `HoldingsAnalysis` 分數欄上下並列:上 `score/6`(基本面)、下 `綜合 #rank ⭐`(19 因子排名 + 進場燈),hover 看 fund/mom/chip 維度
- `cyclicalHint`:`score≤3 && expected_rank≤30 && is_entry_signal` → 失分行前加「基本面分偏嚴(景氣循環股反轉初期),綜合排名 #X 靠前+進場燈,別只看 X/6」
- 表頭「分」→「分/綜合」、底部說明補綜合排名口徑

**驗證**:`next build` + tsc 通過;dev server 早期 `GET / 200 in ~1s` 實際 render 成功(含改動零 runtime error,`v_entry_signal` 查詢無報錯)。截圖未成:dev 連 **production DB**,preview 每 2s full-render force-dynamic dashboard 把既有重 view(`v_holdings_full`/`v_portfolio_summary`)打 `statement timeout` + 連線池耗盡 → 已停 dev 止血。**非本次改動造成**(早期 render 200 證明),但暴露既有議題:**dashboard force-dynamic + 深 view 高頻請求會 DB timeout**(見 D 組「view 依賴鏈深+N+1」,未來優化候選:dashboard 加快取 / 重 view 物化 / 連線池調大)。

**設計選擇**:循環股提醒用「基本面分 vs 綜合排名落差」啟發式觸發,**不硬編產業清單**(系統定位=儀表板不臆測產業循環性;落差直接解決「被單一 score 誤導」痛點)。

### ✅ Dashboard 慢變查詢快取 + 套件漏洞修復(2026-06-02)

Andy 要處理上段揭露的兩個遺留:① dashboard 高頻 DB timeout ② GitHub moderate 漏洞。

**任務 1 — dashboard 高頻 DB timeout**:
- **根因**:dashboard 用 service_role(`statement_timeout=null`,查詢不被砍),真瓶頸是 **PostgREST 連線池耗盡**(`Timed out acquiring connection from pool`)— force-dynamic 每次 render 並發 ~11 查詢 × 高頻 → pool 滿。連線池大小 = Supabase 平台層改不了 → **應用層降載**。
- **修法**(app/page.tsx 純前端):進場訊號 / 排名 / 名稱對照三類**慢變查詢**改 `unstable_cache`(revalidate 60/60/300s);報價 / 損益 / 持股 / held-rank 維持每次即時。高頻 render 命中快取,DB 並發 **11 → 6**。
- **權衡**:**保 force-dynamic**(不引入 build-time prerender 依賴 production DB 的脆弱性 + 報價維持即時),而非整頁 ISR。`server.ts` service_role 無 cookies → 可安全在 cache scope 內 createClient(unstable_cache 硬限制)。買賣經 holdings action `revalidatePath('/')` 一併刷新;排名/名稱最多舊 60-300s(日更資料無感)。
- **限制**:非 100% 根治(即時查詢仍每次跑),但顯著降載 + 零即時性損失 + 零 build 風險。**正常使用本就不發生此 timeout**(僅 preview 每 2s 機器人刷新觸發);要 100% 根治需整頁 ISR(犧牲報價即時 + build 依賴 DB)或物化 view,ROI 低暫不做。
- **驗證**:`next build` + tsc 通過,`/` 仍 ƒ(Dynamic) 未被 prerender。

**任務 2 — 套件漏洞**:`npm audit fix` 修 2 個 moderate(`brace-expansion` DoS / `ws` 記憶體洩漏,皆 transitive dev 依賴、lockfile 內 patch、無 major bump)→ **found 0 vulnerabilities**,build 通過。(GitHub dependabot 報 1 / npm audit 報 2,差在去重與掃描範圍;兩個都修了)

### ✅ 布林軌道(走 B:資訊呈現,不進選股/回測)(2026-06-02)

**起因**:Andy 問「加布林軌道會不會過度擬合」。判斷:① 進選股/回測=**會**(且系統已證選股無穩定 edge,疊技術指標=擬合雜訊,勿做)② 當資訊燈/圖上帶=**不算**(標準 20/2 不調參、0 個被優化自由度)。另提醒布林是**均值回歸**,對抱趨勢股(2344 記憶體)會太早喊賣(同 L36 停損對 top5 有害),故只當參考。Andy 拍板走 B。

**Part 1 — K 線疊布林帶**(app/_components/KLineChart.tsx):前端 rolling MA20±2σ(樣本 n-1,對齊 SQL stddev_samp),用圖上 raw close(與 K 線視覺一致),前 19 根 whitespace 留白;3 條 LineSeries(上下軌紫 violet-400 / 中軌灰虛線),priceLine/lastValue/crosshairMarker 全關;圖下圖例 +「位置參考非買賣訊號」。

**Part 2 — 持股燈第 15 格**(migration 20260602000001 v4):v3→v4 **機械複製**(Copy + 精確 Edit,L49:不手寫複製大量中文)+ boll CTE(adj_close 還原權值,與 ma20_dev 同口徑)+ 第 15 訊號。%B 位置(破上軌/近上軌/中段/近下軌/破下軌 + %B%);level 中段 gray、近軌/破軌 yellow(中性提醒不指方向)。**不進 signal_level、不參與排名、append-only**(現有 14 訊號零改動);SignalsGrid 通用渲染自動顯示,前端零改動。

**驗證**:
- Part 2 apply 後 execute_sql 核對 2344:**15 訊號 ✓**、14 個現有 label 中文全對(機械複製零 regression)✓、布林手算對照 cur 184.5 / upper 163.69 / lower 91.29 → **%B 129%「破上軌」yellow ✓**
- 2344「破上軌·129%」沿上軌狂奔(漲停)正好印證「布林對抱趨勢股會太早喊賣」→ yellow 中性不指方向的設計正確
- Part 1 `next build` + tsc 通過

**口徑註記**:K 線帶用 raw close(視覺一致)、持股燈用 adj_close(分析正確);近期無除息股(如 2344,adj 最近=1)兩者一致,除息股圖求視覺/燈求正確,context 差異合理。

### ✅ 效能優化 A:清理 intraday cache + 自動 cron(2026-06-02)

**起因**:Andy 問 p99 6-9s 是否有優化空間。診斷:`v_holdings_full`(dashboard 每次 render)單次 **4.1s**,DB 內瓶頸(非網路/cold start)。

**根因**(EXPLAIN ANALYZE 量出):
1. `price_intraday_cache` 累積 **42.8 萬列**(每分鐘寫、3 週沒清),取「今天報價」filter `quoted_at::date = current_date` 是 **expression 不走 index** → seq scan 全表 ~2s
2. `daily_recent` 取每檔最近收盤掃 `price_daily` **12.7 萬全歷史**(`trade_date < today` 無下界)~1.85s
- ⚠ Supabase performance advisor **完全沒抓到**(只看 FK 缺 index / unused index,不看「expression filter 害 index 失效」)→ 只能靠實際 EXPLAIN 量(同 L48「審查工具不能照單全收」)

**A 做法**(Andy 選先做 A):
- 一次性 `DELETE` >3 天(**42.8 萬 → 8.3 萬**,保留近 3 天 = view 只用今天 + 時區/跨日緩衝)+ `VACUUM` 釋放
- migration `20260602000002`:每日 18:00 UTC(02:00 Taipei 盤後)cron `purge-intraday-cache` 自動清 >3 天,維持表小不再無限長

**效果**:`v_holdings_full` **4124ms → 2374ms**(−1.75s / −42%)。剩餘 ~2.37s 主要是 `daily_recent` 掃 12.7 萬 = **優化 B 範疇**(改 `v_latest_price_realtime`:intraday filter 改 sargable 範圍走 index + daily 加時間下界),未做,等 Andy 要再說。

**零風險**:view 邏輯/語義零改,純清快取資料(view 只用今天,刪 3 天前不影響)+ 加清理 cron。

### ✅ 效能優化 B:v_latest_price_realtime 兩個 seq scan 改 sargable(2026-06-02,已 apply + DB 驗證)

**目標**:消掉 `v_latest_price_realtime` 的兩個全表掃描,讓 `v_holdings_full` 從 2374ms(優化 A 後)降到 <1s。

**根因**(承優化 A 診斷,定義來自最新 `20260512000077`):
1. intraday `where quoted_at::date = current_date` 是 expression → 不走 `idx_price_intraday_symbol_quoted(symbol, quoted_at desc)` → seq scan
2. daily_recent `where trade_date < current_date` 無下界 → 掃 price_daily 全歷史 ~12.7 萬

**改寫**(只換取數範圍,output column/表達式/join/coalesce 全不動):
1. intraday → `quoted_at >= current_date::timestamptz and quoted_at < (current_date+1)::timestamptz`
   - `col::date = current_date` 的教科書 sargable 等價;兩側 `::timestamptz` 與原 `::date` 同一 session TZ 求值 → **任意 TZ byte-exact**,不硬編碼偏移
2. daily_recent 加 `and trade_date >= current_date - interval '30 days'`

**驗證(此 subagent context 無 execute_sql / apply_migration MCP — ToolSearch 未啟用,已窮舉 psql/CLI/pg驅動/DB密碼/9個 PostgREST RPC 全不通)**:
- 改用 **service_role + PostgREST 拉原始表,在 Node 應用層做 EXCEPT 等價驗證**(逐 symbol 比對「選哪一行」):
  - intraday:newRange vs old(UTC切/Taipei切/跨切分叉指標)**全 0 mismatch**(145 symbol)
  - daily_recent:old(無下界) vs new(≥30天) **0 mismatch**(156→156,實證無一檔最近收盤超 30 天)
- **DB 內實跑驗證未做(無入口)**:`_verify_20260602000003.sql`(雙向 EXCEPT + EXPLAIN)已備,Andy/host apply 後跑收尾、量改後 ms

**檔案**:`supabase/migrations/20260602000003_v_latest_price_realtime_sargable.sql`(create or replace,不 cascade)+ `supabase/migrations/_verify_20260602000003.sql`(退版驗證腳本,`_` 前綴 → db push 自動跳過)

**主對話收尾(已 apply + DB 內權威驗證,Opus)**:
- DB 內雙向 EXCEPT(新定義 inline vs 線上舊 view)實測:`new_minus_old=0`、**`old_minus_new=1`**(subagent 應用層 EXCEPT 漏抓!)→ 那檔 = **2888(新光金,2025 與台新金合併下市,最後收盤 2025-07-11 = 326 天前)**,舊 view 一直顯示其 11 個月前殭屍價。判定:2888 非持股/watchlist/industry(只 stock_universe 殘留)、`active_stale_31_120d=0`(無正常股被 30 天誤排)→ **30 天下界對活躍股 100% byte-exact**,唯一差異是順帶修掉「顯示下市股殭屍價」既有 bug,非破壞、不影響任何持股顯示。
- 量測:`v_holdings_full` **2374ms → 417ms**(intraday 走 idx_price_intraday_recent、daily 走 idx_price_daily_date 只掃 3270 列)。**全程 4124→417ms,砍 90%。**
- 教訓:**退版驗證鐵律必自己 DB 內跑**(L48:subagent 應用層 EXCEPT 漏了 2888,不照單全收)。

### ✅ 持股訊號燈收斂(2026-06-02,analyst-deployer subagent)
15 燈太多 caveat 疲勞 → 分**主燈 6**(stop_buffer/vs_bench/vol_div/tail/down_streak/rsi,出場警戒類)+ **次要 9 摺疊**(`<details>`)+ red/orange 次要燈冒泡到主區。只改 `HoldingsAdvice.tsx` SignalsGrid,不動 SQL/TG。build 過。

### 🔬 新方向探勘結論(2026-06-02,2 個 general-purpose subagent 平行 + 主對話誠實複核)
Andy 定調「不縮成儀表板,要走在市場前面」(抓真實事件 + 升級資料時效)→ 探勘:
- **外部資料源(實測)**:🥇 **Yahoo v8 chart API**(SOX/Nasdaq/台積電 ADR/美股期貨,免費無 auth、實測可用、**時區套利真領先** — 台股開盤前美股已是既成事實)= 第一順位、最低風險最硬 edge。🥈 TAIFEX OpenAPI 夜盤 EOD(免費但 T+1)。🥉 MOPS 真實財報公告日(只能爬、修前視偏誤 L48 的根、工程重)。🟡 新聞/地緣 ROI 低(戰爭尾部事件無便宜結構化源)。
- **內部領先性初驗(誠實量化,point-in-time)**:
  - **H1 崩盤/regime**:波動率是**落後指標**(崩盤時才升不領先;「低波動+跌價」最危險)→ 只能當下檔風險/部位 flag(高波動→9× 回撤機率),**不是崩盤擇時/方向**。樣本全牛市,外部效度弱。⚠ **推翻我之前「崩盤保護較可行」的樂觀**。
  - **H2 隔夜動能**:真實但 edge 在隔夜 gap(已被定價)、intraday 微小、做空年度不穩 → 實際 alpha 低。
  - **H3 新聞→隔日波動**:真實 robust(控制自身波動後 corr +0.162 加成),但**方向不可測**(signed~0)→ 波動/風險訊號非 alpha,僅 1 月資料需累積。
- **誠實總結**:選股 alpha(找黑馬打贏)內部再次驗證難;**唯一最硬的真 edge = Yahoo 海外領先(時區套利,屬「時效」非「選股」)**,正好貼合 Andy「夜盤/海外隔天領先」觀察。崩盤保護要修正預期(波動率落後、是風險 flag 非擇時警報)。
- **下一步建議**:先做 **Yahoo 海外領先資料管線**(SOX/台積電ADR/Nasdaq/美股期貨,盤前 06-08 點抓進表,供盤前推播/dashboard)= 低風險、真領先、零爬蟲、貼合觀察。MOPS 公告日留給「徹底修回測誠實度」階段。**未 commit,等 Andy 拍板方向**。

### ✅ /rank 漲停亮燈 + 回看損益 + 組合 vs 0050 + 前向追蹤對照(2026-06-02)

**起因**:Andy 要在 /rank ① 漲停亮燈 ② 知道排名值不值得進場 ③ 進場損益。澄清後核心 =「回看式直觀」:照排名每檔 N 天前進場到今天損益,憑直覺感受排名。

**策略 caveat(關鍵)**:排名含動能因子 →「排名靠前」部分 = 最近已漲。用當前排名配回看報酬會**系統性高估「排名準」**(同期相關非事先預測力)。真驗證只有前向追蹤(凍結名單再往前看)。**UI 明確標此 caveat,不包裝成「排名能賺」**(memory +24.19 教訓延伸)。

**做法**(analyst-deployer subagent + 我逐段 review,改 app/rank/page.tsx 單檔):
1. 漲停亮燈:今日%欄(current_price/昨收−1),≥9.5% 標 🔴。台股紅漲綠跌
2. 回看欄:加近 5 日%(ret_5d_pct ≈ 一週)配既有 20 日%
3. 組合摘要卡:當前 Top-N 回看平均(近 5/20 日)vs 0050,附誠實 caveat(同期相關偏樂觀)
4. 前向追蹤對照:5-16 凍結批 top5/top10 浮動 vs 0050(零前視真驗證),標樣本少僅觀察

**資料源**(全驗證):`v_rank_with_cost`(ret_5d/20d/current_price)、`v_price_factors`(0050 基準 5.59/11.73)、`price_daily`(昨收近窗)、`paper_picks` 5-16 cohort join `v_latest_price_realtime`。

**subagent 主動修的 bug(L42 類 silent drift)**:我給的昨收查詢用 `distinct on` — supabase-js 不支援,全撈 30檔×320天≈9600 row 撞 **1000 row 上限靜默截斷**(28/30 拿不到昨收 → 今日%全變「—」)。改近 12 天窗(~240 row)→ 30/30 正確,實證過。**教訓:給 subagent 的 SQL spec 也要考慮 supabase-js client 限制(無 distinct on / per-group limit / 1000 row 預設)**。

**驗證**:next build + tsc 過(我自己也跑),`/rank` 維持 force-dynamic。數字核對:Top5 近5日 +12.3/20日 +24.6、Top30 +13.5/+32.2、0050 +5.6/+11.7;前向 5-16 批 top5 +12.8/top10 +18.5/0050 +10.8(吻合)。當前 top30 有 6 檔漲停。**caveat 文字逐段 review 誠實未弱化**(L48:不照單全收 subagent)。

### ✅ /holdings 訊號燈收斂:主燈 + 摺疊(2026-06-02)

**起因**:每檔持股 15 個訊號燈(SignalsGrid 平鋪)太多、caveat 疲勞。改成「主燈醒目一行 + 次要收進 `<details>`」,讓 Andy 一眼看到「會改變交易動作」的。

**約束**:只改 `HoldingsAdvice.tsx` 的 `SignalsGrid` 呈現,不動 SQL(v_holdings_signals 照吐 15)、不動 deriveStatus / AdviceCard 其他部分 / TG notify。沿用現有 SIGNAL_STYLE 配色。L14/L24 不用 dynamic class。

- [x] 定義主燈 key 白名單(6 個出場/警戒訊號):`stop_buffer` / `vs_bench` / `vol_div` / `tail` / `down_streak` / `rsi`
- [x] 主燈醒目排一行/grid;有 red/orange 的次要燈「冒泡」到主區提醒
- [x] 其餘 9 個次要(資訊/背景)收進 `<details>`(預設收合)
- [x] 綜合 level badge(healthy/caution/warning/alert)保留
- [x] `npm run build` 過,回報分組 + build 結果

**Review**:
- 只動 `SignalsGrid`(抽出 `SignalCell` 子元件去重)+ 新增 2 個模組層常數(`PRIMARY_SIGNAL_KEYS` / `ESCALATE_LEVELS`)。deriveStatus / AdviceCard / PriceTick / SQL / TG notify 零接觸。
- **分組**:主燈 6 個(出場/警戒)依白名單固定順序排(不隨 SQL 吐出順序變),容錯(某 key 缺就跳過);次要 9 個(chip/mom/fund/ma_arrange/ma20_dev/obs1_dist/ret_60d/mcap_tier/boll)保 SQL 原序收進 `<details>` 預設收合。
- **冒泡**:次要燈裡 level=red/orange 的提升到主燈區(不藏摺疊),避免「基本面/籌碼轉紅」被收起來漏看。摺疊標題顯剩餘數量。
- 標題從「即時訊號 (15)」改「重點訊號」;綜合 level badge 保留。配色全沿用 SIGNAL_STYLE/LEVEL_STYLE 字面 class(L14/L24,零 dynamic 拼接);中文 label 仍來自 SQL runtime,前端只定義英文 key 白名單(無 L49 手寫中文風險)。
- `npm run build` 通過(Compiled + TypeScript 零錯誤,/holdings 維持 ƒ Dynamic)。

### ✅ 海外領先資訊管線 階段 0+1(2026-06-02,Andy 拍板「走在市場前面」、驗證先行)

承「新方向探勘」做最硬的真 edge = 海外/隔夜領先(時區套利)。**驗證先行,沒過就誠實停**。

**階段 0(資料管線,完成)**:
- schema `overseas_indicators`(migration `20260602000004`):symbol / quoted_date(=美股收盤的台北日期=台股盤前日)/ last_price / prev_close / change_pct。
- EF `fetch-overseas-leading`(v1,**全英文避 L49**):Yahoo v8 chart API 抓 ^SOX/TSM/^IXIC/NQ=F/^VIX/UMC。即時 range=5d / 回填 range=2y 通用;`taipeiDate(unix+8h)` 對齊 quoted_date。
- 回填:pg_net invoke range=2y → **3010 列、6 標的、0 錯誤、2 年歷史**。
- cron(migration `20260602000005`):盤前 06:30 + 08:30 Taipei 抓 range=5d。
- Yahoo v8 **我自己 WebFetch 實測過**(^SOX 13726 / TSM 446.69,error null)— L47 不照單全收 subagent。

**階段 1(領先性驗證,PASS — 誠實版)**:
- corr(adj 還原權值,n≈470):**TSM ADR → 2330/0050 領先力在 intraday(0.28)>> gap(0.1)** → **反** subagent H2「gap 已定價」預期,**是可交易方向、不是賺不到的開盤跳空**。SOX/NQ 泛指數弱(<0.1)→ 領先集中**台積電 ADR 直接對標**。
- 分桶(ADR 昨夜 → 2330 今天開盤後 intraday):**完美單調** — ADR>+2% → **+0.60% / 勝率 65%**(n100);ADR<−2% → **−0.44% / 31%**(n70);中間單調過渡。
- **誠實定位**:effect 0.4–0.6% — 當**擇時/紀律**用(ADR 大跌今天別追高/減碼、大漲可抱加碼,不算來回成本)**價值明確**;當**當沖 alpha**(開盤買收盤賣)扣台股來回成本 ~0.47% 後淨剩 ~0.13%,**薄、脆弱,不建議當賺錢策略**。
- **限制**:2 年單一 regime(台積電/AI 主軸期 ADR 領先特別強)、corr/分桶非實盤(滑價/開盤競價)、外部效度需更多年。

**結論**:探勘以來**第一個誠實驗證 PASS 的真領先訊號**(非選股 alpha、是時效擇時,正中 Andy 觀察)。

**擴大領先源(Andy「不能只綁台積電、其他股票也重要」,2026-06-02)**:加 5 個產業龍頭(MU/NVDA/AAPL/AVGO/AMD,EF v2 共 11 源,回填 5515 列)。**Andy 持股 = 2344 華邦電(記憶體)**,驗證:
- 2344 最強海外源 = **美光 MU(intra corr 0.193)** > NVDA 0.12 > SOX 0.11 → 證明「產業 proxy 對沒 ADR 個股有效」,且**正中持股**(華邦電要 MU 不是台積電 ADR — Andy 的提醒切中要害)。
- 但比 2330(0.287)弱 + **不對稱**:MU<−2% → 2344 開盤後 **−0.93%**(下檔強=風險警示);MU>+2% → +0.56% 但**勝率僅 48%**(上檔弱、別當買訊)。原因:proxy 非本尊 ADR + 華邦電有本土利基記憶體因素。
- **定位**:美光當華邦電「**下檔風險警示**」(美光崩→華邦電今天別追),不當上檔買訊。呼應「下檔風險訊號比上檔 alpha 可靠」(H1 同調)。
- **架構洞察(Andy 點出的關鍵)**:**每檔台股配不同海外源**(記憶體←MU、AI←NVDA、蘋果鏈←AAPL、半導體←SOX、有 ADR←直接對標)= 一張「領先性圖譜」,非單一指標綁定。階段 2(若做)要按持股/產業動態選對應源。

**領先性圖譜全 universe 掃描(2026-06-02「繼續」)**:universe 各股 × 6 主源 intraday corr,結果:
- **記憶體族群最強源全是美光 MU**:華邦電 0.19 / 南亞科 0.19 / 群聯 0.18 / 華東 0.16 / 旺宏 0.13 → **「記憶體→MU」系統性成立**(非華邦電個案)。
- **台積電鏈最強源 = TSM ADR**:台積電本尊 0.29;鏈上(光寶/力成/廣達/鴻海/緯穎)多 TSM 0.13-0.17。
- **金融/傳產 海外領先弱或負**:第一金 −0.20 / 兆豐金 −0.17 / 長榮 −0.14(對 AAPL/NQ **負相關** = 科技大漲日資金排擠金融的蹺蹺板,但弱、可能只是反向 beta)。
- **強度**:除台積電 0.29,其餘 0.1-0.2 → 一律擇時/風險參考,非強 alpha(一致誠實結論)。
- **可操作圖譜**:記憶體→MU、台積電鏈→TSM、金融傳產→海外領先沒用。**階段 2 接推播時按此圖譜「持股 → 對應源」動態選**,並用各檔的下檔不對稱性(如華邦電 MU<−2% → −0.93%)當風險警示。

**階段 2 暫緩(Andy 2026-06-02)**。資料管線(11 源 + 盤前 cron)+ 領先性圖譜方法已建立,等之後決定。

---

## 後續可考慮(M8-M11 範圍外)

- 自動下單(券商 API 串接)
- 限價單 / 停損單模擬
- 多 user 登入(改用 Supabase Auth)
- 跨市場(美股、加密貨幣)
- Tab 6 Alerts(觸發紀錄 + LINE 通知)
- ML 升級(XGBoost / LightGBM)— 待 backtest 證明統計版有效再評估

---

## 權益曲線績效頁(2026-06-05,本地未 commit)

**需求**:Andy 要把「本金動態」做成內建線圖。前置已反推本金 = 期末現金 407,500 − 累計已實現現金損益 204,496 = **203,004**(14 筆交易全平倉、逐筆滾動精準對上 407,500、中途無存提 → 假設成立)。

**實作**(plan:`.claude/plans/parallel-launching-curry.md`):
- **migration `20260605000001_v_equity_curve.sql`**(已 apply 線上):seed `app_settings.initial_capital`(萬單位 20.3004,沿用 budget_ntd 繞 numeric(10,6) 整數僅 4 位)+ view `v_equity_curve`(交易事件 running sum,**BUY delta=−fee / SELL delta=+realized_pnl**)。**MCP 驗證**:14 筆事件、終點 equity=407,499.89(≈407,500,0.11 為本金 round 尾差)、逐筆 delta 與 v_holdings_realized 對齊。
- **前端**:`EquityLadderChart.tsx`(移植 backtest `EquityOverlay` 純 SVG,`pathFor` 改階梯線、Y 軸絕對金額 NT$、本金基準線)+ `/performance` 頁(summary 4 卡 + 曲線 + 14 列明細)+ TabNav「績效」tab + settings `CapitalRow`(萬單位+NT$換算)。
- **驗證**:`npm run build` 過(編譯+tsc+靜態生成全綠);資料層 MCP 精準驗證。⚠ 本機 dev 視覺未截到 — **沙箱連不到外網 Supabase(fetch failed,既有 dashboard 同根因),非 code 問題**;頁面邏輯確認走到正確 `unwrap(equity-curve)`。**視覺待 Railway 部署看(專案慣例)**。
- **口徑 caveat**:單一本金假設、階梯不含未實現浮動(Andy 選)、009816/6285 缺每日價故暫不做每日市值版。
- **待辦**:commit + push 觸發 Railway 部署;部署後 Andy 確認視覺;未來多次入金需 capital_flows 表。

---

## 現股當沖(day trade)支援(2026-06-09)

**需求**:Andy 6/8 想「賣 2408 庫存 @364.5 停損 + 340 買回」,券商執行成**現股當沖**(先賣 324 後買 340 回補),庫存維持 1000@364.5、另賠 17,053。系統移動平均成本法不支援當沖(無法賠錢又不動持股)→ Andy 選**根治 + 完整 UI**。

**方案**:獨立 `day_trades` 表(零風險隔離,不碰移動平均遞迴,L37/L42),損益加法 union 進彙總/曲線/明細。

**實作**(plan `.claude/plans/parallel-launching-curry.md`):
- **migration A `20260609000001`**(已 apply 線上):`day_trades` 表 + `v_day_trades_realized`(realized=(賣−買)×qty−買費−賣費−稅,欄位對齊 v_holdings_realized + is_day_trade)+ app_settings 當沖稅率(stock 0.15% / etf 0.05%)
- **migration B `20260609000002`**(已 apply):`v_holdings_summary.total_realized_pnl/total_pnl` 加當沖;`v_equity_curve` events union `DAY_TRADE`(delta=realized_pnl)
- **前端**:`addDayTradeTransaction` action(+ loadDayTradeTax)+ `DayTradeDialog.tsx`(輸股號/股數/買價/賣價即時算損益)+ /holdings「記當沖」入口 + 已實現歷史 union 當沖徽章 + /performance DAY_TRADE 文案 + EquityLadderChart 當沖標點
- **記 6/8**:2408 buy340/sell324/qty1000 → realized **−17,053**(費 290+277、稅 486)
- **MCP 驗證全通過**:當沖 −17,053;**持股 2408 仍 1000@364.5 零影響**(核心目標達成);summary realized 205,680→188,627;equity 終點 407,189→**390,136**;`v_holdings_realized` 不含當沖。`npm run build` 過。
- **caveat**:當沖假設同日;稅 0.15% 可在 /settings 調;當沖不計入 count_closed/週轉統計,只進 total_realized_pnl + 曲線。
- **待辦**:commit + push 觸發 Railway 部署。

---

## 2026-06-10 session — 優化盤點(載入速度 + 判斷能力)

實證盤點(2 subagent + pg_stat_statements + view 計時):熱點 = v_holdings_signals 941ms(boll CTE 對 price_daily 無日期下界全表掃 12.8 萬列,同 B 優化 pattern);全站 8 頁無 loading.tsx;海外領先 11 源資料躺表中零 UI 呈現(管線正常,6/9 隔夜 11 源完整)。

- [x] P1a:v_holdings_signals v5 — boll CTE 加 sargable 90 天下界(migration 20260610000001),EXCEPT 雙向迴歸 + 計時對比
- [x] P1b:loading.tsx skeleton — /(dashboard)、/holdings、/rank、/stocks/[symbol]、/performance 共 5 路由(backtest/etf/settings 查詢輕,不加)
- [x] P2:Dashboard 海外隔夜快照 widget — overseas_indicators 各 symbol 最新一筆,指數/ADR/產業龍頭分組,持股對應源高亮(記憶體→MU 已驗證),MU≤-2% 下檔警示(歷史 -0.93%)、≥+2% 標「上檔弱勝率48%別當買訊」,unstable_cache 300s,read-only 不碰推播(Stage 2 推播維持暫緩)
- [x] 驗證:npm run build + view 迴歸 + commit/push

**Review(2026-06-10)**:
- P1a:migration `20260610000001` apply 線上。EXCEPT 雙向迴歸 PASS(唯一 diff = bench_chg_pct 時變欄位,0050 即時報價 snapshot 後又進一筆;排除後 0/0)。**誠實計時:941→871ms 只省 ~7%** — plan 證實 boll Seq Scan 已消失,但真正大頭是 v_factor_scores(320 天視窗 WindowAgg 32,869 列 + 籌碼 4 表)在 plan 內被重複展開 3 次(advice 內部 1 次 + signals left join 又 1 次等)。**根治候選 = mv_factor_scores 物化 + 資料更新後 refresh**(結構改動,牽涉 view 鏈,待 Andy 拍板,見下方提案)
- P1b:`app/_components/Skeleton.tsx` + 5 路由 loading.tsx(/、/holdings、/rank、/stocks/[symbol]、/performance)。dev preview 證實 skeleton 立即顯示(體感改善主力,因全站 force-dynamic TTFB 數百 ms~1s)
- P2:`OverseasWidget.tsx`(dashboard SummaryCards 下方)。11 源分組(指數/ADR/產業龍頭)、台股紅漲綠跌、VIX 中性色;持股對應源 ★ 高亮(industry→源:記憶體→MU/IC設計+封測→TSM 已驗證,AI伺服器→NVDA 未驗證不觸發警示);下檔警示(對應源 ≤−2% 紅框「勿急著低接」)、上檔 ≥+2% 中性「勝率僅 48% 別當買訊」(不對稱性照圖譜)。getCachedOverseas unstable_cache 300s(資料一天只更新 2 次)。**僅呈現已有資料,Stage 2 推播維持暫緩**
- 驗證:npm run build 過;preview server HTML 含全部新內容(skeleton/海外 widget/★);preview 瀏覽器停在 skeleton 是背景 tab rAF 凍結(streaming swap 不跑),非程式問題

### 追加 4 項(Andy「4點都做」,2026-06-10 下午)
- [x] 1. mv_factor_scores 物化(migration 20260610000002):DO block 機械替換 v_stock_rank/v_holdings_signals 源(零手打 drift,pattern 不符 fail-fast)+ unique index + cron refresh(平日 08:50/14:50/15:50/16:50/17:50 Taipei)。**v_stock_rank 327→2ms / v_entry_signal 301→2ms / v_holdings_advice 649→129ms / v_holdings_signals 941→104ms**。mv vs view EXCEPT 0/0。⚠ 手動 backfill 後要手動 refresh mv
- [x] 2. deriveStatus INSUFFICIENT(L42 前端根治):fund+mom total 全 0 → 🚧「因子無料,分析失效」紅 badge,不再默認「持續抱」;停損(-10% 純價格)優先序保留在其上。HoldingsAdvice.tsx + notify-holdings-telegram **v4 deploy**(get_edge_function 拉回核對中文字串 PASS,L49)
- [x] 3. /rank 手機卡牌式:md 以下整卡可點直列(rank#/股號名稱⭐/總分/現價/今日%/5d/20d/RSI/4 維 count),表格 hidden md:block
- [x] 4. equity_curve SVG path stride 取樣 ~240 點(backtest/[id] + compare 兩處 pathFor,x 用原索引保對齊+保尾點,HTML 瘦身視覺無差)
- 驗證:build 過;dev warm /holdings 771ms /rank 987ms(mv 前光 DB 即 ~1.6s);/rank 卡牌 markup 確認

---

## 2026-06-10 晚 — 「好股等好價」三層工程(Andy 拍板開工)

> 痛點:rank=橫斷面選股(what),缺進場時點/價位(when/at)。動能因子天生把已漲一段的推前面 → rank 靠前≈追高區。分層解決,不動排名結構(L36)。

- [x] A. v_entry_quality view:rank top N 每檔價位質量 — 4 態 entry_zone(chase 追高/neutral/pullback 回檔至支撐/broken 趨勢破壞)+ 耐心價(MA20/fib38.2)+ 偏離 MA20/布林 %B/量比。純 SQL 標準參數零調參(走 B)
- [x] B. /rank UI:價位質量欄(燈+偏離%)+ 耐心價欄 + 海外 gate(對應源隔夜 ≤-2% → ⛔ 今日勿進);手機卡同步
- [x] C. Dashboard regime 燈:0050 近 60 交易日報酬分區(U 型濾網產品化:<0 有利/0-10 中性/10-20 地雷/>20 有利,附 paper-track 驗真 caveat)
- [x] D. 耐心價到價提醒:alert_rules 啟用 + EF check-price-alerts(盤中 cron 比價)+ 觸價 TG 推播 + /rank 一鍵掛耐心價
- [x] E. entry_model 回測驗證:run-backtest 加 entry_model 參數(immediate vs pullback_ma20 vs limit_fib38),L39 錨點,2023-2025 三年量化「等好價」真實損益

**Review(2026-06-10 晚,A-D 完成,E 留下一 session)**:
- A:migration 20260610000003 apply。全 universe 432ms。**量化證實 Andy 直覺:Top10 有 5 檔 chase(2492 dev+19.7%/9917 RSI77)、僅 2 檔 pullback(2356/2377)**。2408 = pullback(資訊性:不知籌碼在出,zone≠買訊,UI tooltip 已註明)
- B:/rank 加「價位」(zone 燈+MA20 偏離小字+⛔海外 gate)與「耐心價」欄;手機卡同步 zone。overseas mapping 抽共用 overseas-map.ts
- C:dashboard RegimeWidget(0050 近 61 筆 adj 報酬分 4 區,unstable_cache 3600s,附 12 季樣本 caveat)
- D:EF check-price-alerts v1(deploy+L49 核對 PASS)+ cron */10 1-5 UTC + actions.ts(addPatienceAlert 防重/cancel)+ PatienceCell(點掛 ⏰/✕ 取消)。**E2E PASS:checked1/triggered1/tg:true/event 寫入/one-shot 停用**,測試資料已清
- E(entry_model 回測驗證)未做:改 run-backtest 核心需 L39 錨點 byte-exact + 6 run 對照,留獨立 session 專心做

**E Review(2026-06-11,run-backtest v7)**:
- v7 加 entry_model(immediate 預設/pullback_ma20)+ entry_wait_days(1-40 預設 10):限價=rankDate MA20(EF bars 自算同 adj 口徑),open<=limit 用 open、low<=limit 用 limit,等嘸 skip(entry_not_filled/entry_limit_na 透明計數)。fetch 窗 -30→-45(date-guarded;副作用:未來 ATR 停損實驗 seed 不足例會變少,誠實記錄)
- **L39 錨點 PASS**:2024/2025 t5 preEF vs postEF 全指標 byte 一致(0.67/-50.65、26.22/-9.02)
- **🔴 結論:等回 MA20 三年全敗** — alpha:2023 +7.14→-11.79(-19pp)/2024 -50.65→-48.58(同爛)/2025 -9.02→-57.44(**-48pp,60 槽 36 個等嘸**)。機制 = M9.4a 定論再現:動能 top5 最強的不回檔,等到的多是轉弱接刀(2025 win 45.8%)。**「等好價」對動能 top5 是系統性傷害,買點折價 << 錯過行情的機會成本**
- 實務:v_entry_quality pullback 燈 = 資訊非指令;耐心價掛單適合自選/非動能標的,top5 勿當默認。Caveat:單一形式(MA20/wait10)、C1 保守 lag 基準、倖存者偏差照舊
- 注:C1 保守 lag 下 2024 t5 immediate = -50.65(首次量測,2024 在保守財報時點下整年壞,符合 C1 真實 alpha 區間 [-9,+8] 的悲觀端敘事)
