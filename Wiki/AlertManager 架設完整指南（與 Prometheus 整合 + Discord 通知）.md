# AlertManager 架設完整指南（與 Prometheus 整合 + Discord 通知）

**適用情境**：  
已部署 **Prometheus** 監控系統，需加入 **告警管理與多渠道通知**（如 Discord）。  
本教學以 **dev 環境**為例，使用 **Docker Compose** 部署 **AlertManager**，實現：
- 自動接收 Prometheus 告警  
- 依嚴重度分流通知  
- 透過 **Discord Webhook** 即時推播  
- 支援告警合併、去重、靜音

---

## 環境前提

| 項目 | 狀態 |
|------|------|
| Prometheus | 已運行於 `192.168.10.209:9090` |
| Docker Compose | 已安裝 |
| Discord | 已建立 3 個 Webhook（critical / warning / info） |

---

## 第一步：建立告警規則 `rules/alerts.yml`

> 路徑：`./rules/alerts.yml`

```yaml
groups:
  - name: node-alert-rules
    rules:

      # 1. CPU 使用率 > 95%
      - alert: HighCPUUsage
        expr: 100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 95
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "CPU 使用率過高 ({{ $labels.instance }})"
          description: "CPU 使用率超過 95%，目前為 {{ $value | printf \"%.1f\" }}%"

      # 2. 記憶體使用率 > 90%
      - alert: HighMemoryUsage
        expr: (node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes * 100 > 90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "記憶體使用率過高 ({{ $labels.instance }})"
          description: "記憶體使用率超過 90%，目前為 {{ $value | printf \"%.1f\" }}%"

      # 3. 磁碟使用率 > 90%
      - alert: HighDiskUsage
        expr: (node_filesystem_size_bytes{fstype!~"tmpfs|overlay"} - node_filesystem_free_bytes{fstype!~"tmpfs|overlay"}) / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"} * 100 > 90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "磁碟空間使用率過高 ({{ $labels.instance }} - {{ $labels.mountpoint }})"
          description: "掛載點 {{ $labels.mountpoint }} 使用率超過 90%，目前為 {{ $value | printf \"%.1f\" }}%"

      # 4. 系統 Load 超過 CPU 核心數
      - alert: HighLoadAverage
        expr: node_load1 > count(node_cpu_seconds_total{mode="system"}) by (instance)
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "系統 Load 過高 ({{ $labels.instance }})"
          description: "1 分鐘平均 Load 超過 CPU 核心數，Load1: {{ $value }}"

      # 5. 主機宕機
      - alert: HostDown
        expr: up == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "主機無回應 ({{ $labels.instance }})"
          description: "此主機已無法被 Prometheus 偵測，可能已宕機或網路中斷"

      # 6. 時鐘飄移 > 5 分鐘
      - alert: ClockSkewDetected
        expr: abs(node_time_seconds - time()) > 300
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "主機時鐘飄移 ({{ $labels.instance }})"
          description: "主機時間與 Prometheus 相差超過 5 分鐘"
```

---

## 第二步：修改 `prometheus.yml`（加入 AlertManager）

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - "/etc/prometheus/rules/*.yml"  # 載入所有 rules

alerting:
  alertmanagers:
    - static_configs:
        - targets:
            - 'alertmanager:9093'  # 容器內部 DNS

scrape_configs:
  # ... 你的 scrape 設定
```

---

## 第三步：建立 `docker-compose.yml`

```yaml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:v3.3.0
    container_name: prometheus
    restart: always
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --web.enable-remote-write-receiver
      - --enable-feature=exemplar-storage
      - --web.enable-lifecycle
    volumes:
      - ./data/prometheus:/prometheus
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - ./rules:/etc/prometheus/rules
    ports:
      - "9090:9090"
    networks:
      - monitoring

  alertmanager:
    image: prom/alertmanager:v0.26.0
    container_name: alertmanager
    restart: always
    volumes:
      - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml
      - ./data/alertmanager:/alertmanager
    ports:
      - "9093:9093"
    command:
      - --config.file=/etc/alertmanager/alertmanager.yml
      - --storage.path=/alertmanager
    networks:
      - monitoring

networks:
  monitoring:
    driver: bridge
```

---

## 第四步：建立 `alertmanager.yml`

```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'severity', 'instance']
  group_wait: 10s
  group_interval: 30s
  repeat_interval: 99h
  receiver: 'default-discord'

  routes:
    - receiver: 'critical-discord'
      match:
        severity: critical
      repeat_interval: 24h

    - receiver: 'warning-discord'
      match:
        severity: warning
      repeat_interval: 99h

    - receiver: 'info-discord'
      match:
        severity: info
      repeat_interval: 99h

receivers:
  - name: 'critical-discord'
    discord_configs:
      - webhook_url: 'https://discord.com/api/webhooks/XXXXXXXXXXXXX/critical'
        send_resolved: true
        title: '{{ .CommonAnnotations.summary }}'
        color: 15158332  # 紅色

  - name: 'warning-discord'
    discord_configs:
      - webhook_url: 'https://discord.com/api/webhooks/XXXXXXXXXXXXX/warning'
        send_resolved: true
        title: '{{ .CommonAnnotations.summary }}'
        color: 16776960  # 黃色

  - name: 'info-discord'
    discord_configs:
      - webhook_url: 'https://discord.com/api/webhooks/XXXXXXXXXXXXX/info'
        send_resolved: true
        title: '{{ .CommonAnnotations.summary }}'
        color: 3447003   # 藍色

  - name: 'default-discord'
    discord_configs:
      - webhook_url: 'https://discord.com/api/webhooks/XXXXXXXXXXXXX/default'
        send_resolved: true
```

---

## 第五步：建立目錄與啟動

```bash
# 建立必要目錄
mkdir -p ./data/{prometheus,alertmanager} ./rules

# 啟動服務
docker compose up -d --build
```

---

## 驗證與測試

### 1. 檢查服務狀態
```bash
docker ps | grep -E "prometheus|alertmanager"
```

### 2. 開啟 AlertManager UI
> http://192.168.10.209:9093/#/alerts

### 3. 手動觸發測試告警（Prometheus）

在 Prometheus UI 執行：
```promql
ALERT TestAlert
  IF up == 0
  FOR 1m
  LABELS { severity = "critical" }
  ANNOTATIONS { summary = "手動測試告警", description = "這是測試" }
```

→ 應在 **1 分鐘內** 收到 Discord 通知

---

## SE/DevOps 最佳實務建議

| 項目 | 建議 |
|------|------|
| **持久化** | 掛載 `data/alertmanager` 避免靜音狀態遺失 |
| **高可用** | 部署 **AlertManager 叢集**（3 節點） |
| **靜音（Silence）** | 透過 UI 或 API 設定維護期間靜音 |
| **多渠道** | 加入 Slack / Email / PagerDuty |
| **告警分流** | 使用 `team: frontend` 等 label 分流 |
| **模板化** | 自訂 Discord 訊息樣板（`message` 欄位） |
| **監控健康** | 加入 `alertmanager_notifications_total` 指標 |

---

**完成！**  
您已成功部署 **AlertManager**，實現：
- Prometheus 告警自動觸發  
- 依嚴重度分流至不同 Discord 頻道  
- 告警合併、去重、已解決通知  
- 可視化管理介面  

> **專業提醒**：  
> 生產環境建議搭配 **Grafana Alerting** 作為備援，並使用 **Thanos** 實現告警歷史查詢。
