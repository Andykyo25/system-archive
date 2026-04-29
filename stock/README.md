# 台股戰情室 · TWSE War Room

自用看盤 / 復盤工具。串接：

- **TWSE OpenAPI** — 盤後精準資料（收盤指數、三大法人、融資融券、漲跌幅排行）
- **FinMind** — 盤中即時 + 歷史 K 線、月營收、財報、三大法人個股
- **Yahoo Finance** — 國際指數備援（費半 SOX、NASDAQ、SP500）

---

## 系統需求

- Node.js ≥ 20（內建 `fetch`，無需安裝額外套件）
- 瀏覽器（Chrome / Edge / Firefox）

如果還沒裝 Node：

```bash
# Windows（winget）
winget install OpenJS.NodeJS.LTS

# 確認
node --version    # 應 ≥ v20
npm --version
```

---

## 啟動

```bash
cd C:\Users\GWANDYCHIANGX1\Documents\AI\system-archive\stock

# 第一次：安裝依賴
npm install

# 啟動後端 + 提供前端靜態檔
npm start
```

開啟瀏覽器：[http://localhost:5174](http://localhost:5174)

`npm run dev` 用 `node --watch`，改 server 端會自動重啟。

---

## 部署選項

### A. Railway（最簡單，連 GitHub 一鍵）

1. push 到 GitHub
2. 到 [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Variables 加 `FINMIND_TOKEN`（其他變數已有預設）
4. 部署完點 Public Domain，瀏覽器即可開

> Railway 約 $5/月（一個小 Node service 跑滿月才會用到那麼多）。
> 海外 IP 偶爾撞 Yahoo 429，但有 TWSE MIS 主源所以即時報價不受影響。

### B. 自家 Linux Server（Docker，最穩、免費）

```bash
# server 上：
git clone https://github.com/<you>/stock.git && cd stock

# 寫 .env（不會進 Git）
cat > .env <<EOF
PORT=5174
FINMIND_TOKEN=你的_token
CACHE_TTL_HISTORICAL_MS=86400000
CACHE_TTL_REALTIME_MS=5000
EOF

# 起 container
docker compose up -d --build
docker compose logs -f
```

開啟 `http://server-ip:5174`。要 HTTPS 前面掛 nginx / Caddy / Traefik 反向代理。

### C. GitHub Actions 自動部署到自家 Server（B 的延伸）

`.github/workflows/deploy.yml` 已附。在 GitHub Repo → Settings → Secrets and variables → Actions 加：

| Secret | 內容 |
|---|---|
| `DEPLOY_HOST` | 你 server 的 IP / domain |
| `DEPLOY_USER` | SSH 使用者 |
| `DEPLOY_PATH` | server 上 repo 路徑（如 `/srv/stock`） |
| `SSH_PRIVATE_KEY` | 部署用 SSH 私鑰（整個 BEGIN/END 區塊） |
| `FINMIND_TOKEN` | 你的 FinMind token |

push 到 `main` 後 Actions 會自動跑 syntax check + rsync + docker compose up。

> ⚠️ TWSE MIS 是台灣本地 API，從台灣 IP 打最穩；cloud server 在境外時 Yahoo 偶爾撞 429 但有 MIS 主源不影響核心功能。

---

## 設定

`.env` 已建立。三個關鍵設定：

```
PORT=5174
FINMIND_TOKEN=...      # ← 你的 token，已寫入；建議到 finmindtrade.com 重新生一個
CACHE_TTL_REALTIME_MS=5000
CACHE_TTL_HISTORICAL_MS=86400000
```

> ⚠️ `.env` 已在 `.gitignore`，**不會** commit 進 Git。
> 你提供的 token 已外露在對話歷史，**建議重生** 後更新此檔。

---

## 目錄結構

```
stock/
├─ index.html              # 入口
├─ styles.css
├─ src/                    # 前端模組
│  ├─ main.js              # 啟動、註冊事件
│  ├─ state.js             # 集中狀態 + pub/sub
│  ├─ scheduler.js         # 依交易時段決定 polling 頻率
│  ├─ data/
│  │  ├─ api.js            # 統一打 /api 後端
│  │  └─ mock.js           # 離線備援資料
│  ├─ ui/                  # mount/update 拆分（修記憶體洩漏）
│  │  ├─ topbar.js, sidebar.js, indices.js
│  │  ├─ heatmap.js, movers.js, aside.js
│  │  ├─ stockPanel.js, portfolio.js, postPanel.js
│  │  └─ charts.js         # Chart.js 實例集中管理
│  └─ utils/
│     ├─ format.js, cache.js (localStorage TTL)
├─ server/                 # Node 後端（Express）
│  ├─ server.js            # API 路由 + 靜態檔服務
│  ├─ session.js           # 台股交易時段判斷（Asia/Taipei）
│  ├─ cache.js             # in-memory cache (memo + TTL)
│  └─ providers/
│     ├─ twse.js           # 證交所 OpenAPI
│     ├─ finmind.js        # FinMind
│     └─ yahoo.js          # Yahoo Finance（chart endpoint）
├─ package.json
├─ .env / .env.example / .gitignore
└─ 台股戰情室.html          # ⚠ 舊單檔備份，可保留或刪除
```

---

## 資料調度策略

| 時段 | 主來源 | 備援 | Polling |
|---|---|---|---|
| 盤中（9:00–13:30）大盤指數 | FinMind 5 秒 K | TWSE MI_INDEX | 5 秒 |
| 盤中個股報價 | FinMind 快照 | Yahoo `XXXX.TW` | 5–15 秒 |
| 國際指數（^SOX / ^IXIC） | Yahoo | — | 60 秒 |
| **盤後（14:30+）收盤精準** | **TWSE OpenAPI** | FinMind | 一次 |
| 個股 K 線歷史 | FinMind | — | 切股時抓，localStorage 快取 1 分鐘 |
| 月營收 / 財報 | FinMind | — | localStorage 快取 1 天 |
| 三大法人個股 | FinMind | — | localStorage 快取 10 分鐘 |
| 融資融券個股 | FinMind | — | localStorage 快取 10 分鐘 |

**容錯**：後端 `chain()` 會依序試 N 個 provider，全失敗才回 502；前端 `api.*` 失敗會 fallback 到 `mock.js`。

---

## API 路由（後端）

| 路徑 | 用途 | 主源 |
|---|---|---|
| `GET /api/health` | 健康檢查 + 目前 session | — |
| `GET /api/indices` | 台股 + 國際指數 | FinMind / TWSE / Yahoo |
| `GET /api/stocks` | 上市股票清單 | FinMind |
| `GET /api/kline/:code?days=90` | K 線 | FinMind |
| `GET /api/quote/:code` | 個股盤中快照 | FinMind / Yahoo |
| `GET /api/institutional/:code` | 三大法人個股 | FinMind |
| `GET /api/margin/:code` | 融資融券個股 | FinMind |
| `GET /api/revenue/:code` | 月營收 | FinMind |
| `GET /api/financial/:code` | 財報 | FinMind |
| `GET /api/movers` | 漲跌幅排行 | TWSE STOCK_DAY_ALL |
| `GET /api/postmarket/summary` | 盤後彙整 | TWSE 全 endpoint |

---

## 已修的問題（vs 原單檔版）

1. **Chart.js 記憶體洩漏** — 原本 `setInterval(3000)` 重新 `new Chart()` 但從不 `destroy()`，現在透過 `src/ui/charts.js` 集中管理。
2. **全量重渲染** — 拆 mount/update：架構建一次，tick 只改文字與 class。
3. **資料層耦合** — 抽出 `DataProvider` 與後端 `chain()` fallback。
4. **無 polling 節流** — `scheduler.js` 依時段切換頻率，休市時降到 5–10 分鐘。
5. **K 線每次切股都重生隨機** — 改為從 FinMind 抓真實資料，並有 localStorage 快取。
6. **字型 fallback** — 加上 `system-ui, -apple-system, "Microsoft JhengHei"`。
7. **盤後精準資料** — 新增 `#post-panel` 區塊，顯示 TWSE OpenAPI 彙整。

---

## 開發備忘

**盤中時段 TWSE 部分 endpoint 會回 302 / HTML 維護頁**（如 `/v1/fund/BFI82U`、`/v1/fund/T86`），這是 TWSE 行為非 bug。後端 `twse.js` 的 `fetchJson` 會檢測並丟錯，由 `chain()` fallback 到 FinMind。

**FinMind 限額**：免費版每分鐘 600 次請求。前端的 `localStorage` 與後端的 `cache.js` 都有 TTL，正常使用不會撞限。

**新增資料源**：
- 寫一個 `server/providers/xxx.js` 暴露 async function
- 在 `server.js` 對應 route 用 `chain(...)` 加進備援鏈即可
- 不需要改前端

**清前端快取**：瀏覽器 DevTools → Application → Local Storage → 刪 `twr:*`

---

## 待辦 / 後續想法

- [ ] 真實新聞抓取（聯合、鉅亨、Yahoo 新聞）
- [ ] WebSocket / SSE 取代 polling（FinMind 部分付費方案有）
- [ ] 自訂自選股清單（取代寫死的 mock stocks）
- [ ] 警示推播（Webhook → LINE Notify，可串你現有的 `line-notify` 系統）
- [ ] 換成 K 線專用圖庫（lightweight-charts / ECharts），原生 OHLC 比 Chart.js 折線完整
