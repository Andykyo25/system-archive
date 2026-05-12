# 台股持股分析系統

Andy 自用,單人 SaaS。把持股 + watchlist 的價量 / 法人 / 籌碼 / 基本面接到 Supabase,自動算多因子排名,個股頁有 K 線 / 雷達圖 / 新聞,並用 backtest harness 驗證選股規則。

---

## 架構

```
                ┌─────────────────────┐
                │  Railway (Next.js)  │
                │   App Router · SSR  │
                └──────────┬──────────┘
                           │  anon key
                           │  (server actions 用 service_role)
                           ▼
   ┌───────────────────────────────────────────────────┐
   │              Supabase Project                     │
   │  ┌─────────────────────────────────────────────┐  │
   │  │  Postgres (40+ tables / 20+ views)          │  │
   │  │    holdings_transactions / price_daily /    │  │
   │  │    price_intraday_cache / stock_universe /  │  │
   │  │    stock_fundamentals_quarterly /           │  │
   │  │    stock_institutional / stock_margin /     │  │
   │  │    stock_shareholding / stock_lending /     │  │
   │  │    stock_monthly_revenue / stock_news /     │  │
   │  │    backtest_runs / backtest_trades ...      │  │
   │  └─────────────────────────────────────────────┘  │
   │  ┌─────────────────────────────────────────────┐  │
   │  │  Edge Functions (15 個)                     │  │
   │  │    fetch-daily-prices · fetch-yahoo-...     │  │
   │  │    fetch-finmind-{fallback / fundamentals / │  │
   │  │      valuation / monthly-revenue /          │  │
   │  │      institutional / margin / shareholding /│  │
   │  │      lending / backfill}                    │  │
   │  │    fetch-etf-metadata · fetch-stock-news    │  │
   │  │    reselect-industry-stocks · run-backtest  │  │
   │  └─────────────────────────────────────────────┘  │
   │  ┌─────────────────────────────────────────────┐  │
   │  │  pg_cron 排程(10+ job)                      │  │
   │  │  pg_net 觸發 EF · vault 存 JWT + token       │  │
   │  └─────────────────────────────────────────────┘  │
   └────────┬────────────────┬─────────────────────────┘
            │                │
            ▼                ▼
   ┌──────────────┐  ┌────────────────┐
   │  TWSE / TPEX │  │ FinMind v4 API │  + Yahoo (現已換 TWSE MIS 即時揭示)
   │   OpenAPI    │  │  (備援 + 法人 / │  + Google News RSS
   │ (主力收盤)   │  │   基本面 / 籌碼)│
   └──────────────┘  └────────────────┘
```

**設計原則:**
- 使用者路徑只讀 Supabase。所有外部 fetch 都在 pg_cron 排程裡完成(L02)
- 主力 / 備援切換不能造成「價格跳動」:`price_daily` 走 first-write-wins,但「主力可覆蓋 provisional,不能覆蓋主力」(L11 / L17)
- 即時報價(`price_intraday_cache`)走覆寫式 cache,跟收盤 lock 邏輯完全分開(L18)
- 不做 Auth(單人專案),`robots.txt` 擋爬蟲,寫入操作走 server actions 用 `SUPABASE_SERVICE_ROLE_KEY`

---

## 技術棧

- **前端**:Next.js 16.2.5(App Router · Turbopack)+ React 19 + Tailwind v4 + TypeScript
- **圖表**:lightweight-charts v5(K 線)+ 自寫 SVG(雷達圖 / equity curve)
- **後端**:Supabase(Postgres + Edge Functions + pg_cron + pg_net + vault)
- **資料源**:TWSE / TPEX OpenAPI(主力)、FinMind v4(備援 + 基本面 + 法人 + 籌碼)、TWSE MIS 揭示 API(盤中即時)、Google News RSS(新聞)
- **部署**:Railway(Docker · Node 24-alpine · standalone)
- **版本**:Node 24+(`engines.node: ">=22"`)

---

## 環境變數

`.env.example` 列出所有必要 key。本機開發拷一份到 `.env.local`:

| Key | 用途 |
|-----|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL(前端可見) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key,前端讀資料用(RLS 全 enable) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role,後端 server actions 寫資料用,**絕不可放到 client bundle** |
| `FINMIND_TOKEN` | FinMind 免費版 token,給 Edge Function。實際上 EF 從 Supabase vault 拉(`select vault.create_secret(...)`),env 只是 backup |

`.env*` 進 `.gitignore`,只有 `.env.example` 進版本。

Supabase 還有兩個 vault secret 是直接在 DB 建,不放 env:
- `edge_function_auth`:service_role JWT,給 pg_cron 觸發 EF 用
- `finmind_token`:FinMind token,EF 透過 `select read_finmind_token()` SECURITY DEFINER RPC 取

詳見 lesson L10。

---

## Edge Functions(15 個)

| EF | 用途 | 觸發 |
|----|------|------|
| `fetch-daily-prices` | TWSE + TPEX 主力收盤,寫 `price_daily`(first-write-wins,主力可覆蓋 provisional) | cron 平日 14:30 / 22:00 |
| `fetch-finmind-fallback` | FinMind 補主力缺(`is_provisional=true`) | cron 平日 16:00 |
| `fetch-yahoo-intraday` | 盤中即時報價(實際是 TWSE MIS,Yahoo 公開 quote API 2024 起 401),寫 `price_intraday_cache` | cron 平日盤中每 5 分 |
| `fetch-finmind-fundamentals` | EPS / 淨利 / ROE / FCF(季) | cron 週一 03:00 |
| `fetch-finmind-valuation` | PE / PB / 殖利率(日) | cron 平日 16:30 |
| `fetch-finmind-monthly-revenue` | 月營收(YoY 自動算) | cron 週一 04:00 |
| `fetch-finmind-institutional` | 三大法人買賣超(日) | cron 平日 17:00 |
| `fetch-finmind-margin` | 融資融券餘額 / delta(日) | cron 平日 17:05 |
| `fetch-finmind-shareholding` | 集保戶數 / 外資持股比例(週) | cron 週日 03:00 |
| `fetch-finmind-lending` | 借券明細(日) | cron 平日 17:10 |
| `fetch-finmind-backfill` | 通用回填:吃 `dataset+start+end+offset+limit`,8 個 dataset 共用,給歷史回測用 | 手動 trigger |
| `fetch-etf-metadata` | 從 FinMind 篩 ETF metadata,寫 `etf_metadata` | cron 週日 04:00 |
| `fetch-stock-news` | Google News RSS(zh-TW),每 symbol 20 篇 | cron 每 6 小時 |
| `reselect-industry-stocks` | 月初自動重選 industry_stocks(`locked=false` 才會踢) | cron 月 1 號 11:00 |
| `run-backtest` | walk-forward 回測,呼 `score_universe_at(as_of_date)` PG function 拿歷史視角排名 | UI form 或 API |

部署:`supabase functions deploy <name>` 或透過 MCP `deploy_edge_function`(把 source JSON-escape 後塞 `files[0].content` — L15)。

---

## pg_cron 排程表

時區換算備忘:**pg_cron 跑 UTC**,Taipei = UTC+8。

| 時間(Taipei) | UTC cron | EF | 備註 |
|------|---------|----|------|
| 平日 09:00 - 13:55 每 5 min | `*/5 1-5 * * 1-5` | fetch-yahoo-intraday | 盤中即時(TWSE MIS) |
| 平日 14:30 | `30 6 * * 1-5` | fetch-daily-prices | 收盤後第一次,TWSE 可能還沒給 T 日 |
| 平日 16:00 | `0 8 * * 1-5` | fetch-finmind-fallback | TWSE T 日缺時 FinMind 補 |
| 平日 16:30 | `30 8 * * 1-5` | fetch-finmind-valuation | PE/PB |
| 平日 17:00 | `0 9 * * 1-5` | fetch-finmind-institutional | 法人 |
| 平日 17:05 | `5 9 * * 1-5` | fetch-finmind-margin | 融資券,錯 5 min 避 quota peak |
| 平日 17:10 | `10 9 * * 1-5` | fetch-finmind-lending | 借券 |
| 平日 22:00 | `0 14 * * 1-5` | fetch-daily-prices | 第二次,把 14:30 還沒到的 T 日補上;主力可覆蓋 provisional(L17) |
| 週日 03:00 | `0 19 * * 6` | fetch-finmind-shareholding | 集保戶數(週頻) |
| 週日 04:00 | `0 20 * * 6` | fetch-etf-metadata | ETF 篩選 |
| 週一 03:00 | `0 19 * * 0` | fetch-finmind-fundamentals | 財報數據 |
| 週一 04:00 | `0 20 * * 0` | fetch-finmind-monthly-revenue | 月營收 |
| 月 1 號 11:00 | `0 3 1 * *` | reselect-industry-stocks | 月初換股(L21 避 UTC 月跨日) |
| 每 6h(0/6/12/18 UTC) | `0 */6 * * *` | fetch-stock-news | Taipei 02/08/14/20 |

查 cron 狀態:`select * from cron.job order by jobname;`

---

## 部署(Railway)

Railway root directory 設 `stock/`,builder = Dockerfile,環境變數設 4 個(見上)。

每次 `git push` 到 `main`,Railway 會自動 build & deploy。Build 流程在 `Dockerfile`:

1. `npm ci` 裝依賴
2. `npm run build`(Next.js standalone output)
3. runner stage 只 copy `.next/standalone` + `.next/static` + `public`,non-root user 跑

`.dockerignore` 排除 `supabase/`、`tasks/`、`.claude/`(避免 Edge Function 的 Deno-only `jsr:` import 把 Next.js TS check 弄炸,見 L08)。

本地 build verify:

```powershell
& "C:\Users\<user>\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.15.0-win-x64\npm.cmd" run build
```

---

## 操作指引

### 新增買入 / 賣出

「持股」tab 上方有「新增買入」form。賣出按該檔 row 的「賣出」按鈕 → 對話框,輸入股數 + 價格,即時預覽損益。

Schema 上是 `holdings_transactions` 表,每筆 BUY / SELL 為 row;`v_holdings_current` / `v_holdings_realized` / `v_holdings_summary` 算未實現 / 已實現。

費率自動從 `app_settings` 拉(`commission_discount × commission_base_rate` 計手續費,ETF / 一般股不同證交稅)。在「設定」tab 改。

### 手動 trigger 歷史回填

新籌碼 / 基本面 dataset 上線後,要回填 ~3 年歷史才能 backtest。一天能跑一個 dataset(FinMind free quota 600 calls/day,200 symbol × 1 call ≈ 200 ~ 600):

```bash
curl -X POST 'https://<project>.supabase.co/functions/v1/fetch-finmind-backfill' \
  -H 'Authorization: Bearer <service_role_jwt>' \
  -H 'Content-Type: application/json' \
  -d '{"dataset":"price","start_date":"2023-01-01"}'
```

`dataset` 支援:`price` / `institutional` / `margin` / `monthly_revenue` / `fundamentals` / `valuation` / `shareholding` / `lending`。

每次 return 內含 `quota.used` / `quota.budget` / `next_offset_hint`,quota 撞滿時用 `symbol_offset` 分頁,隔日再來:

```bash
-d '{"dataset":"institutional","start_date":"2023-01-01","symbol_offset":100,"symbol_limit":100}'
```

排程一輪 7-10 天可以把 3 年資料補完。期間 backtest 沒意義(`run-backtest` 會 graceful `status=failed reason=insufficient_data`)。

### 跑 backtest

「Backtest」tab 上方 form 填 name / 起訖日 / rebalance days / Top K / benchmark(預設 0050)→ 送出。

成功時詳情頁顯示:
- 4 個 metric 卡:總報酬 / 年化 / 勝率 / 對 benchmark 超額
- equity curve(策略 vs benchmark)
- 月度 PnL bar
- 每筆 trade 清單(限 200)

通過條件:勝率 > 55% 且年化 alpha > 5%(vs 0050)→ 上線。沒通過就砍規則重來,不上線。

EF 走 sync await,沒早 return 的時候 user 等可能 30-60s。長 backtest 改 fire-and-forget(L27)是 future work。

### 因子解讀

「排名」tab top 30 + 個股頁雷達圖:

- **基本面 (6 個 factor)**:EPS 連 4 季正 / EPS YoY+ / ROE > 15% / FCF > 0 / PEG < 1 / 月營收 YoY > 0
- **動能 (3)**:MA20 / MA60 黃金交叉 / 20 日 vs 60 日報酬加速 / RSI14 < 70
- **反轉 (2)**:距 60 日高點折價 > 10% / 5 日跌幅 > 3% 但量縮
- **籌碼 (4)**:法人 3 日買超 / 融資餘額減 / 借券減 / 外資持股比例升

加權:fund 50% / mom 25% / rev 15% / chip 10%。**某維度全 null 時權重 reallocate 給其他維度**,所以資料未就緒不會把名次擠歪。

進場訊號(⭐):
- fund_count_pos ≥ 4(硬條件)
- mom_count_pos ≥ 2(硬條件)
- chip 三層 fallback:資料 ≥ 3 個 factor 嚴格 ≥ 2 / 1-2 個放寬 / 0 個不卡

L25 的設計 — 資料就緒前後規則「自動升級」,UI 不會閃斷。

### 現價 timestamp 顯示

各表格現價下方一行小字:
- `15 min ago · twse_mis` — 盤中即時(< 30 min)
- `今日收盤` — 主力今天已到
- `2026-05-09 收盤` — 主力今天還沒到,顯示最近一筆
- 黃字 + ⚠ — `is_provisional`(備援資料)

hover 顯示完整時間 + 來源。

---

## 已知限制 / 待補

- **股票池 ~150 檔**:`stock_universe` 表;spec 是 ~200,Andy 後續可 SQL `INSERT` 補。**不能掃全市場**(L01,quota 撐不住)
- **TWSE OpenAPI T+1 延遲**:14:30 cron 抓到的是「上個交易日」資料;22:00 第二次 cron + 主力可覆蓋 provisional 機制處理(L17)
- **Yahoo Finance quote API 2024 起 401**:server-to-server 需 cookie+crumb auth;`fetch-yahoo-intraday` EF 名稱保留但實作換成 TWSE MIS 即時揭示(L18 衍生)
- **First-write-wins(daily)**:`price_daily` 同一 (symbol, trade_date) 不可被任何 source 覆蓋(L11)。Provisional 例外:主力可覆蓋 provisional(L17)
- **Backtest 等資料就緒**:M8 新接的 4 個籌碼 dataset 需要 3-5 天 cron 累積才有意義;歷史回測要 backfill 完 ~3 年資料
- **Reconciliation 簡化**:沒做 audit log;靠 first-write-wins 確保「不跳價」
- **Tab 6 Alerts 沒做**:`alert_rules` / `alert_events` schema 在但沒 eval batch / 沒 UI / 沒 LINE 推播。M7 未排程
- **FinMind 免費 quota 600 calls/day**:平日 cron 一天能跑 4 dataset × 150 ≈ 600 calls,差不多踩線;若超會 graceful 跳過剩餘(隔天 cron lookback 10 天會補回)。Andy 上付費版(1000 / 3000 /day)可放寬

---

## Lessons

關鍵教訓寫在 `tasks/lessons.md`(L01 ~ L28),被使用者糾正過的模式都進去。每次開新 session 先翻。

## Milestone

M0 ~ M11 完成,詳見 `tasks/todo.md`。

---

## 授權

私人專案,不對外。
