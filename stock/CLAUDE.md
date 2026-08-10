# CLAUDE.md — 工作準則

> 用途:壓低 LLM 常見錯誤的行為準則。與專案專屬說明合併使用。
> Tradeoff:這份偏向「謹慎優先於速度」。瑣碎任務自行斟酌。

---

## 一、核心紀律（Behavioral Guidelines）

### 1. 想清楚再動手（Think Before Coding）

不臆測、不藏困惑、攤開 tradeoff。動手前:

- 明說假設(assumptions)。不確定就問。
- 有多種解讀(interpretation)就全列出來,不要默默選一個。
- 有更簡單的做法就講。該 push back 就 push back。
- 有東西不清楚就停下來,指出哪裡卡住,然後問。

### 2. 簡單優先（Simplicity First）

解決問題的最小程式碼,不寫臆測性的東西。

- 不加沒被要求的 feature / 抽象(abstraction) / 彈性 / 設定性(configurability)。
- 不為不可能發生的情境寫 error handling。
- 寫了 200 行但其實 50 行能解決 → 重寫。
- 自問:「senior engineer 會嫌這過度複雜嗎?」會,就簡化。

### 3. 手術刀式改動（Surgical Changes）

只動非動不可的地方,只清自己製造的爛攤子。

- 不順手「改善」周邊 code / 註解 / 排版。
- 不重構沒壞的東西;沿用既有 style,即使你會用別的寫法。
- 看到無關的 dead code → 講出來,不要刪。
- 自己的改動造成的 orphan(import / 變數 / function)才移除;既有 dead code 沒被要求別動。
- 檢驗:每一行改動都能直接對應到需求。

### 4. 目標驅動執行（Goal-Driven Execution）

先定義成功標準(success criteria),迭代到驗證通過為止。

- 把任務轉成可驗證目標:
  - 「加 validation」→「先寫 invalid input 的 test,再讓它過」
  - 「修 bug」→「先寫一個能重現的 test,再讓它過」
  - 「重構 X」→「確保改動前後 test 都過」
- 多步任務先給簡短計畫,每步附 verify 方法:
  ```
  1. [步驟] → verify: [檢查方法]
  2. [步驟] → verify: [檢查方法]
  ```
- 沒證明能跑,不准標記完成(跑 test、看 log、實際展示正確性)。

---

## 二、任務管理（Task Management）

1. **先寫計畫**:寫進 `tasks/todo.md`,項目要可勾選。
2. **確認計畫**:開始實作前先 check in 一次。
3. **追蹤進度**:做完就把項目勾掉。
4. **解釋變動**:每一步附高層摘要(high-level summary)。
5. **記錄結果**:在 `tasks/todo.md` 加上 review 區塊。
6. **沉澱經驗**:被糾正後立刻更新 `tasks/lessons.md`。

---

## 三、自我改善迴圈（Self-Improvement Loop）

- 只要被糾正過一次:立刻把該模式寫進 `tasks/lessons.md`。
- 為自己訂規則,避免下次重蹈覆轍。
- 反覆迭代 lessons,直到犯錯率降下來。
- 每次開新 session,先翻過該專案相關的 lessons。

---

## 四、Ops / Infra 條款

### 變更安全（Change Safety）

- 任何 config / infra 變更**一律附 rollback 計畫**。
- 破壞性操作(重啟、刪資料、改 access control / 權限)執行前,**先窮舉所有選項與風險,再決定動哪個**,不要直接跳到最激烈的手段。
- 專業任務必含:目的、前置檢查(pre-checks)、詳細步驟、驗證方法、rollback。

### 查證優先（勿臆測環境）

- 環境細節(版本、host、index、naming alias)**先查 Notion 知識庫 / lessons,不要憑印象生成**。
- 版本鎖定的東西不主動升級(例:OTel Java Agent v1.33.6)。
- Canonical 範例(完整集合在 Notion/lessons):
  - container 改 config → 用 `docker compose up -d --force-recreate`,不要只 `restart`(避免 inode swap 沒吃到新設定)。
  - MySQL 層 rollback 唯一手段是 `mysqldump`。

### 輸出格式（Output Format）

- 先給 **Executive Summary**,再給技術細節。
- 正式 ticket / 文件用 **Jira Wiki Markup**(非 Markdown)。
- 程式碼區塊標註語言,關鍵設定加註解。
- **繁體中文,專有名詞保留英文。**
- 有更省錢 / 更安全 / 更高效的替代方案,主動提出。
