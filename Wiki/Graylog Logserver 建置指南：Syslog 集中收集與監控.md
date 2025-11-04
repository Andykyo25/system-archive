# Graylog Logserver 建置指南：Syslog 集中收集與監控

**適用情境**：  
在企業環境中，伺服器與網路設備每天產生大量系統日誌（Syslog），包含使用者登入、系統錯誤、服務啟停等關鍵事件。透過 Graylog 集中收集、分類與監控，能及早偵測異常登入或可疑操作，降低安全風險。  
> 本文以 **Graylog 6.0 + OpenSearch 2.17.1 + MongoDB 7.0** 為例，收集多台主機（201–209）的 Syslog，過濾登入相關訊息（auth、sshd、sudo），並建立 Dashboard 監控。適用於 Ubuntu/Debian 環境。

**SE/DevOps 提醒**：生產環境建議部署於 Kubernetes 或 ECS，搭配 ELK-like 備份策略；OpenSearch 需監控分片健康，避免索引膨脹。

---

## 一、架構總覽

| 組件 | 角色 | 用途 |
|------|------|------|
| **Graylog** | 日誌收集、處理與視覺化工具 | 接收 Syslog/GELF，過濾分類（Stream）、查詢、Dashboard 視覺化、Alert 通知（如異常登入爆量） |
| **OpenSearch** | 全文檢索與分析引擎（取代 Elasticsearch） | 儲存日誌索引，提供高效搜尋與聚合（如登入失敗次數、來源 IP 分佈）；支援分片/副本，提升可用性 |
| **MongoDB** | 設定與中繼資料儲存庫 | 儲存使用者帳號、角色、Stream/Dashboard 設定、Pipeline 規則；不存日誌本體（日誌存 OpenSearch） |

**流程**：  
主機 Syslog → rsyslog 轉送 → Graylog Input (UDP/TCP 1514) → Stream 規則過濾 → OpenSearch 索引 → Dashboard 監控

---

## 二、系統需求

| 項目 | 內容 |
|------|------|
| **OS** | Ubuntu 20.04+ / Debian 11+（201 作為 Graylog 主機） |
| **硬體** | CPU: 4+ 核心；RAM: 8GB+（Graylog 需 4GB+）；磁碟: 100GB+ SSD（日誌成長快速） |
| **工具** | Docker 20.10+、Docker Compose 2.0+、rsyslog、Java 17 |
| **網路** | 防火牆開 9000 (Web)、1514 (Syslog UDP/TCP)；主機間互通 201–209 |
| **權限** | root 或 sudo；IAM 角色若上雲端 |

---

## 三、步驟一：Syslog Server 建置（rsyslog，適用所有主機 201–209）

以 rsyslog 作為本地 Syslog 伺服器，接收並轉送日誌至 Graylog。

### 1. 安裝 rsyslog
```bash
sudo apt update
sudo apt install -y rsyslog
```

### 2. 啟用 TCP/UDP 接收
編輯 `/etc/rsyslog.conf`，新增/確認以下模組（僅 201 作為中繼需啟用）：
```
# UDP 514
module(load="imudp")
input(type="imudp" port="514")

# TCP 514
module(load="imtcp")
input(type="imtcp" port="514")
```

### 3. 建立集中儲存路徑（依 hostname 區分）
在 `/etc/rsyslog.conf` 末尾新增模板：
```
$template RemoteLogs,"/var/log/remote/%HOSTNAME%/%PROGRAMNAME%.log"

*.* ?RemoteLogs
```
```bash
sudo mkdir -p /var/log/remote
sudo chown syslog:adm /var/log/remote
```

### 4. 開防火牆（開發環境可略）
```bash
sudo ufw allow 514/tcp
sudo ufw allow 514/udp
```

### 5. 重新啟動 rsyslog
```bash
sudo systemctl restart rsyslog
sudo systemctl status rsyslog
```

> **驗證**：`logger "test message"` → 檢查 `/var/log/syslog`。

---

## 四、步驟二：安裝基礎環境（僅 201 主機）

### 1. 更新系統
```bash
sudo apt update && sudo apt upgrade -y
```

### 2. 安裝必要套件
```bash
sudo apt install -y apt-transport-https openjdk-17-jre-headless uuid-runtime pwgen gnupg curl docker.io docker-compose
sudo systemctl enable --now docker
```

> **產生 Graylog 必要變數**（在後續 .env 使用）：
> - `GRAYLOG_PASSWORD_SECRET`：`openssl rand -hex 32`（至少 16 字元）
> - `GRAYLOG_ROOT_PASSWORD_SHA2`：`echo -n 'admin' | sha256sum | awk '{print $1}'`（預設密碼 admin，生產改密）

---

## 五、步驟三：建立 Docker Compose 容器（僅 201 主機）

### 1. 建立工作目錄
```bash
mkdir -p /home/ai/it-system/graylog_opensearch/{data/{mongodb,opensearch,graylog},config/graylog}
cd /home/ai/it-system/graylog_opensearch
```

### 2. 建立 `.env` 檔案（參數管理）
```bash
tee .env <<EOF
TZ=Asia/Taipei
OS_JAVA_OPTS=-Xms1g -Xmx1g
GL_JAVA_OPTS=-Xms1g -Xmx1g
GRAYLOG_HTTP_BIND=0.0.0.0:9000
GRAYLOG_PASSWORD_SECRET=$(openssl rand -hex 32)
GRAYLOG_ROOT_PASSWORD_SHA2=$(echo -n 'admin' | sha256sum | awk '{print $1}')
EOF
```

> **注意**：生產環境勿用預設密碼；權限設定：`chmod 755 data/*`、`chmod 777 config/graylog`（暫用，PRD 改 755）。

### 3. 建立 `docker-compose.yml`
```yaml
# By Andy (Graylog 6.0 版本)
version: '3.8'

services:
  mongodb:
    image: mongo:7.0
    container_name: mongodb
    volumes:
      - ./data/mongodb:/data/db
    environment:
      - MONGO_INITDB_ROOT_USERNAME=graylog
      - MONGO_INITDB_ROOT_PASSWORD=Hitrust16313302
      - TZ=${TZ}
    networks:
      - graylog_network
    restart: unless-stopped

  opensearch:
    image: opensearchproject/opensearch:2.17.1
    container_name: opensearch
    environment:
      - cluster.name=opensearch-cluster
      - node.name=opensearch-node
      - discovery.type=single-node
      - bootstrap.memory_lock=true
      - "OPENSEARCH_JAVA_OPTS=${OS_JAVA_OPTS}"
      - DISABLE_INSTALL_DEMO_CONFIG=true
      - DISABLE_SECURITY_PLUGIN=true  # 生產啟用 security
      - TZ=${TZ}
    ulimits:
      memlock:
        soft: -1
        hard: -1
      nofile:
        soft: 65536
        hard: 65536
    volumes:
      - ./data/opensearch:/usr/share/opensearch/data
    networks:
      - graylog_network
    restart: unless-stopped

  graylog:
    image: graylog/graylog:6.0
    container_name: graylog
    environment:
      - GRAYLOG_PASSWORD_SECRET=${GRAYLOG_PASSWORD_SECRET}
      - GRAYLOG_ROOT_PASSWORD_SHA2=${GRAYLOG_ROOT_PASSWORD_SHA2}
      - GRAYLOG_HTTP_EXTERNAL_URI=http://192.168.10.201:9000/  # 改為您的 IP/域名
      - GRAYLOG_HTTP_BIND_ADDRESS=${GRAYLOG_HTTP_BIND}
      - GRAYLOG_JAVA_OPTS=${GL_JAVA_OPTS}
      - GRAYLOG_MONGODB_URI=mongodb://graylog:Hitrust16313302@mongodb:27017/graylog?authSource=admin
      - GRAYLOG_ELASTICSEARCH_HOSTS=http://opensearch:9200  # OpenSearch 端點
      - TZ=${TZ}
      - GRAYLOG_ROOT_TIME_ZONE=Asia/Taipei
    depends_on:
      - mongodb
      - opensearch
    ports:
      - "9000:9000"   # Web Interface
      - "1514:1514/udp" # Syslog UDP
      - "1514:1514/tcp" # Syslog TCP
      - "12201:12201" # GELF
    volumes:
      - ./data/graylog:/usr/share/graylog/data
      - ./config/graylog:/usr/share/graylog/data/config
    networks:
      - graylog_network
    restart: unless-stopped

networks:
  graylog_network:
    driver: bridge
```

### 4. 啟動容器
```bash
docker compose up -d
docker compose logs -f  # 監控啟動（需 2~5 分鐘初始化）
```

> **驗證**：`docker ps` 確認三容器運行；`curl http://192.168.10.201:9000` 回應 HTML。

---

## 六、步驟四：Graylog UI 後台配置 Input

1. 瀏覽器開啟：`http://192.168.10.201:9000`  
   - 登入：**admin / admin**（立即變更密碼）

2. 導航：**System → Inputs**  
   - 搜尋 "Syslog TCP" → **Launch new input**  
   - **Title**: "Syslog TCP Input"  
   - **Bind address**: 0.0.0.0  
   - **Port**: 1514  
   - 勾選 **Allow override date** & **Store full message**  
   - **Save** → 啟用 Input

> **建議**：同時啟用 UDP Input（Port 1514），擇一使用以避免重複。

---

## 七、步驟五：設定 rsyslog 轉送至 Graylog（所有主機 201–209）

### 1. 建立轉送設定檔 `/etc/rsyslog.d/10-graylog.conf`
```bash
sudo tee /etc/rsyslog.d/10-graylog.conf <<EOF
# 轉送所有日誌至 Graylog (TCP 1514)
*.* @@192.168.10.201:1514;RSYSLOG_SyslogProtocol23Format

# 確保 /etc/rsyslog.conf 有以下模組 (接收用)
module(load="imtcp")
input(type="imtcp" port="514")
module(load="imudp")
input(type="imudp" port="514")
EOF
```

> **說明**：  
> - 201 本機用 `@@127.0.0.1:1514`  
> - 202–209 用 `@@192.168.10.201:1514`  
> - `RSYSLOG_SyslogProtocol23Format` 確保 RFC 5424 格式，提升解析度。

### 2. 重新啟動 rsyslog（每台主機）
```bash
sudo systemctl restart rsyslog
sudo systemctl status rsyslog
```

> **驗證**：產生測試日誌 `logger "test to graylog"` → Graylog Search 查詢 "test"。

---

## 八、步驟六：Graylog 配置 Stream（分類登入相關訊息）

Stream 用於動態路由日誌，過濾 auth/sshd/sudo 相關事件。

### 1. 建立 Stream
- **Streams → Create Stream**  
  - **Title**: "Authentication Logs"  
  - **Description**: "SSHD, sudo, auth 相關登入事件"  
  - **Save**

### 2. 添加規則
- 編輯 Stream → **Manage rules → Add new rule**  
  - **Rule 1**: Field: `source` (或 `hostname`)，Value: `ai-w[1-9]`（匹配 201–209 主機）  
  - **Rule 2**: Field: `message`，Value: `regex` → `.*(sshd|sudo|auth|Accepted|Failed|Invalid user).*`（匹配關鍵字）  
  - **Save** → **Enable**

> **進階規則範例**（Pipeline 規則，用於提取 IP/使用者）：  
> 在 **System → Pipelines** 建立 Pipeline，連至 Stream：  
> ```
> rule "Extract SSH Login"
> when has_field("message")
> then
>   let ssh_pattern = regex("^(?<action>Accepted|Failed) (?<method>password|publickey) for (?<user>[^ ]+) from (?<ip>[^ ]+).*", to_string($message.message));
>   set_fields(ssh_pattern);
> end
> ```
> 套用至 "Authentication Logs" Stream。

---

## 九、步驟七：Dashboard 製作與監控

### 1. 建立 Dashboard
- **Dashboards → Create new**  
  - **Title**: "Syslog Authentication Monitor"

### 2. 添加 Widget
- **Aggregation**：  
  - 登入失敗次數：Quick values on `action:Failed` (時間範圍：Last 24h)  
  - 來源 IP 分佈：World map on `ip` 欄位  
  - 主機登入趨勢：Line chart on `source` + `timestamp`  
- **Search**：過濾 `stream_id:"Authentication Logs"`  
- **Save** → 分享給團隊

> **Alert 設定**：**Alerts → Event Definitions** → 新增 "SSH Bruteforce Alert"：  
> - Stream: "Authentication Logs"  
> - 條件：`action:Failed` 計數 > 10 (5 分鐘內)  
> - 通知：Email/Slack（設定 SMTP 在 **System → Configurations**）

---

## 十、驗證與除錯

| 指令/UI | 用途 |
|---------|------|
| `docker compose logs graylog` | 查看 Graylog 啟動錯誤 |
| Graylog **Search**：`source:ai-w4 AND sshd` | 驗證特定主機日誌 |
| `tail -f /var/log/syslog` (主機端) | 確認轉送 |
| OpenSearch 健康：`curl http://localhost:9200/_cluster/health` (容器內) | 索引狀態 |

**常見錯誤**：
- **容器啟動失敗**：檢查 JAVA_OPTS 記憶體、MongoDB 認證。
- **日誌未到達**：防火牆/端口、rsyslog 模板格式。
- **Stream 無資料**：規則 regex 測試（用樣本訊息驗證）。

---

## 十一、SE/DevOps 最佳實務建議

| 項目 | 建議 |
|------|------|
| **安全性** | 啟用 OpenSearch Security Plugin；Graylog HTTPS (Nginx 反向代理 + Let's Encrypt)；RBAC 角色分權 |
| **效能** | OpenSearch 調優：分片 3、副本 1；Graylog JVM 調 Heap (生產 16GB+)；索引輪轉 (TTL 30 天) |
| **備份** | Cron 備份 MongoDB/OpenSearch：`mongodump` & `opensearch-snapshot`；S3 異地備份 |
| **擴充** | 整合 Beats/Filebeat 收集應用 Log；Kubernetes Helm Chart 部署；Prometheus 監控 Graylog Metrics |
| **成本** | 監控索引大小 (`curl http://opensearch:9200/_cat/indices`)；壓縮舊日誌 |
| **升級** | 參考官方 Docker Stack 更新，從 5.x 遷 OpenSearch 需重建索引 |

---

**完成！**  
Graylog 已建置完成，開始監控 201–209 主機的 Syslog。定期檢查 Alert 與 Dashboard，確保安全事件不漏接。

> **專業提醒**：  
> 生產環境整合 SIEM（如 Splunk）或 AWS CloudWatch Logs 作為備援；測試 Bruteforce 情境，驗證 Alert 流程。
