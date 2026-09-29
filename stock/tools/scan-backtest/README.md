# 今日看多回測(scan-backtest)

`run-backtest` EF 只能測多因子排名;這裡是「今日看多」(v_breakout_scan → v_scan_verdict)的全市場回測。
資料直接抓證交所 / 櫃買的按日端點,含期間下市股(無倖存者偏差),不吃 FinMind 配額、不寫正式庫。
還原報酬用交易所的「漲跌價差」自建(參考價 = 收盤 − 漲跌),除權息日自動中性。

## 跑法(Node 24,在本資料夾執行)

```bash
node fetch.mjs twse 2022-07-01 2026-09-26   # 約 1 小時;可與 tpex 同時跑;中斷後重跑會續抓
node fetch.mjs tpex 2022-07-01 2026-09-26
node engine.mjs                              # 產生 signals.json / market.json(約 1 秒)
node validate.mjs                            # 與正式 scan_picks 凍結名單比對(prod_picks.json)
node r2p.mjs                                 # 現行上線規格的回測數字
```

`data/`(約 86 MB)、`signals.json`、`market.json` 不進 git。

## 檔案

| 檔案 | 用途 |
|---|---|
| `fetch.mjs` | TWSE `MI_INDEX?type=ALLBUT0999` / TPEx `otc?type=EW` 按日抓取 |
| `engine.mjs` | 重現 v_breakout_scan 計分、scan_pattern(A/B/C/D + 套牢量)、v_scan_track_v2 報酬口徑,輸出每筆候選的特徵與前向路徑 |
| `lib.mjs` | 統計(pooled / 按日加權)、樣本內外切分、正式滾動信心門檻模擬、出場模擬 |
| `validate.mjs` | 與正式凍結名單比對(2026-09-29:召回 100%、精確 98.6%、型態 134/136) |
| `r2p.mjs` | **上線規格**:R2p 前 3 檔 + 停損 3×ATR14 + 停利 10% + 最長 20 日 |
| `baseline.mjs` | 型態 A/B/C/D 與正式信心門檻機制的逐年成績 |
| `research.mjs` / `featscan.mjs` / `combo.mjs` / `exits.mjs` / `robust.mjs` / `prodfeas.mjs` / `h0.mjs` / `tail2.mjs` | 2026-09-29 的研究過程(假設、分位掃描、組合、出場、門檻高原、正式庫可行版、崩跌反彈檢查、停損寬度) |
| `incl.txt` | 當時 `stock_industry` 未被 `industry_policy` 排除的代號(現行分類,非 PIT) |

## 紀律

- 以 2023–24 定門檻、2025–26 驗證,逐年同向才算數;勝率以按日加權為主(同一天幾百檔一起漲不是獨立證據,見 lessons L75)
- 勝率與扣成本(0.585%)期望值一起看,不接受用小停利灌勝率
- 已知限制:產業分類非 PIT;未計流動性衝擊;池外股正式庫只留 135 天,因此上線版用 60 日高與 0050 季線(`prodfeas.mjs`)
