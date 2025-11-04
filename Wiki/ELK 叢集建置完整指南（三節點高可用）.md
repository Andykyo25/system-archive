# ELK 叢集建置完整指南（三節點高可用）

**適用情境**：  
企業級日誌集中管理，需 **高可用叢集**、**跨主機分片**、**即時搜尋與視覺化**。  
本教學以 **三台實體/虛擬機（201–203）** 部署 **Elasticsearch 8.14.3 叢集**，並在 201 上同時運行 **Kibana + Logstash**，使用 **Docker Compose** 實現零自製映像、最簡配置。

> **SE/DevOps 最佳實務**：  
> - 生產環境建議搭配 **Filebeat/Metricbeat** 收集日誌  
> - 啟用 **HTTPS + X-Pack 安全**（本教學先關閉 SSL，後續可加 Nginx 反向代理）  
> - 定期快照備份至 S3/NFS

---

## 0. 拓樸與版本總覽

| 節點 | IP | 角色 |
|------|----|------|
| ES1 | `192.168.10.201` | Elasticsearch Master/Data + Kibana + Logstash |
| ES2 | `192.168.10.202` | Elasticsearch Master/Data |
| ES3 | `192.168.10.203` | Elasticsearch Master/Data |

| 服務 | 版本 | 埠 |
|------|------|-----|
| Elasticsearch | `8.14.3` | 9200 (HTTP), 9300 (Transport) |
| Kibana | `8.14.3` | 5601 |
| Logstash | `8.14.3` | 5044 (Beats), 50000 (TCP/UDP), 9600 (API) |

---

## 一、先決條件（三台主機皆執行）

### 1. 系統參數調整（ES 必須）
```bash
sudo sysctl -w vm.max_map_count=262144
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-elasticsearch.conf
sudo sysctl --system
```

> **為何？** Elasticsearch 使用 `mmapfs`，預設限制太低會導致啟動失敗或 OOM。

---

### 2. 建立資料目錄與權限
```bash
sudo mkdir -p /opt/elk/elasticsearch/{data,logs}
sudo mkdir -p /opt/elk/kibana/config
sudo mkdir -p /opt/elk/logstash/{config,pipeline}
sudo mkdir -p /opt/elk/compose

# 權限：ES 容器內 UID=1000，需可寫入
sudo chown -R 1000:0 /opt/elk/elasticsearch
sudo chmod -R 775 /opt/elk/elasticsearch
```

---

## 二、通用環境檔 `.env`（每台主機不同）

> 路徑建議：`/home/ai/it-system-docker-compose/elk/.env`

### **201 主機**
```bash
cat > /home/ai/it-system-docker-compose/elk/.env <<'EOF'
ELASTIC_VERSION=8.14.3
ELASTIC_PASSWORD=YourStrongElasticPwd123!

# 叢集通用設定
CLUSTER_NAME=elk-prod
SEED_HOSTS=192.168.10.201:9300,192.168.10.202:9300,192.168.10.203:9300
INITIAL_MASTERS=es-201,es-202,es-203
ES_JAVA_OPTS=-Xms4g -Xmx4g

# 本機節點參數
NODE_NAME=es-201
PUBLISH_HOST=192.168.10.201
DATA_PATH=/opt/elk/elasticsearch/data
LOG_PATH=/opt/elk/elasticsearch/logs
EOF
```

### **202 主機**
```bash
NODE_NAME=es-202
PUBLISH_HOST=192.168.10.202
```
（其餘相同）

### **203 主機**
```bash
NODE_NAME=es-203
PUBLISH_HOST=192.168.10.203
```
（其餘相同）

---

## 三、Elasticsearch 單節點 Compose（三台主機相同檔案）

> 檔案：`docker-compose.es.yml`

```yaml
version: "3.8"

services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:${ELASTIC_VERSION}
    container_name: ${NODE_NAME}
    restart: unless-stopped
    user: "1000:0"
    environment:
      - node.name=${NODE_NAME}
      - cluster.name=${CLUSTER_NAME}
      - discovery.seed_hosts=${SEED_HOSTS}
      - cluster.initial_master_nodes=${INITIAL_MASTERS}
      - network.host=0.0.0.0
      - network.publish_host=${PUBLISH_HOST}
      - xpack.security.enabled=true
      - xpack.security.http.ssl.enabled=false
      - ES_JAVA_OPTS=${ES_JAVA_OPTS}
      - ELASTIC_PASSWORD=${ELASTIC_PASSWORD}
    ulimits:
      memlock:
        soft: -1
        hard: -1
      nofile:
        soft: 65536
        hard: 65536
    volumes:
      - ${DATA_PATH}:/usr/share/elasticsearch/data
      - ${LOG_PATH}:/usr/share/elasticsearch/logs
    network_mode: "host"
```

> **為何用 `network_mode: host`？**  
> 跨主機 9300 節點通訊避免 NAT 問題，穩定性最高。  
> 若防火牆限制，可改用 `ports` 映射，但需確保 9200/9300 互通。

---

## 四、Kibana + Logstash Compose（僅 201 主機）

> 檔案：`docker-compose.kibana-logstash.yml`

```yaml
version: "3.8"

services:
  kibana:
    image: docker.elastic.co/kibana/kibana:${ELASTIC_VERSION}
    container_name: kibana
    restart: unless-stopped
    environment:
      - ELASTICSEARCH_HOSTS=http://192.168.10.201:9200
      - ELASTICSEARCH_USERNAME=elastic
      - ELASTICSEARCH_PASSWORD=${ELASTIC_PASSWORD}
    ports:
      - "5601:5601"
    depends_on:
      - elasticsearch_local

  elasticsearch_local:
    image: docker.elastic.co/elasticsearch/elasticsearch:${ELASTIC_VERSION}
    command: ["/bin/true"]

  logstash:
    image: docker.elastic.co/logstash/logstash:${ELASTIC_VERSION}
    container_name: logstash
    restart: unless-stopped
    environment:
      - LS_JAVA_OPTS=-Xms256m -Xmx256m
      - xpack.monitoring.enabled=false
    volumes:
      - /opt/elk/logstash/config/logstash.yml:/usr/share/logstash/config/logstash.yml:ro
      - /opt/elk/logstash/pipeline:/usr/share/logstash/pipeline:ro
    ports:
      - "5044:5044"          # Beats
      - "50000:50000/tcp"    # 自定義 TCP
      - "50000:50000/udp"    # 自定義 UDP
      - "9600:9600"          # API
    depends_on:
      - elasticsearch_local
```

---

## 五、Logstash 設定檔

### 1. `/opt/elk/logstash/config/logstash.yml`
```yaml
http.host: "0.0.0.0"
log.level: info
xpack.monitoring.enabled: false
```

### 2. `/opt/elk/logstash/pipeline/kafka-to-es.conf`（範例）
```conf
input {
  kafka {
    bootstrap_servers => "kafka-1:9092,kafka-2:9092"
    topics => "pg-server.public.tb_account_takeover_info"
    group_id => "logstash-es-group-ato1"
    codec => "json"
    consumer_threads => 4
    auto_offset_reset => "earliest"
  }
}

filter {
  if ![veriid_trans_id] or [veriid_trans_id] == "null" {
    drop { }
  }

  ruby {
    code => "
      create_time_ms = event.get('create_time').to_i / 1000
      if create_time_ms < 0 || create_time_ms > 9223372036854775807
        event.set('create_time', nil)
      else
        event.set('create_time_ms', create_time_ms)
      end
    "
  }

  date {
    match => ["create_time_ms", "UNIX_MS"]
    target => "create_time"
    timezone => "Asia/Taipei"
  }

  mutate {
    remove_field => ["@version"]
  }
}

output {
  elasticsearch {
    hosts => ["http://192.168.10.201:9200"]
    index => "veri_id_aws_prd_tb_model_account_takeover_predict_data_v2.1"
    document_id => "%{veriid_trans_id}"
    action => "update"
    doc_as_upsert => true
    retry_on_conflict => 5
    manage_template => false
  }
}
```

---

## 六、啟動順序與指令

### A. 啟動 ES 叢集（三台主機依序）

```bash
# 在 201
cd /home/ai/it-system-docker-compose/elk
docker compose -f docker-compose.es.yml up -d

# 在 202（等 201 起來 10 秒）
docker compose -f docker-compose.es.yml up -d

# 在 203
docker compose -f docker-compose.es.yml up -d
```

### B. 啟動 Kibana + Logstash（僅 201）

```bash
docker compose -f docker-compose.kibana-logstash.yml up -d
```

---

## 七、驗證叢集健康狀態

### 1. 檢查叢集狀態
```bash
curl -u elastic:YourStrongElasticPwd123! http://192.168.10.201:9200/_cluster/health?pretty
```

**預期輸出**：
```json
{
  "cluster_name" : "elk-prod",
  "status" : "green",
  "number_of_nodes" : 3,
  "active_shards_percent_as_number" : 100.0
}
```

### 2. 檢查節點
```bash
curl -u elastic:YourStrongElasticPwd123! http://192.168.10.201:9200/_cat/nodes?v
```

### 3. 開啟 Kibana
瀏覽器：`http://192.168.10.201:5601`  
登入：`elastic` / `YourStrongElasticPwd123!`

---

## 八、SE/DevOps 最佳實務建議

| 項目 | 建議 |
|------|------|
| **安全** | 啟用 `xpack.security.http.ssl.enabled=true`，搭配 Nginx + Let's Encrypt |
| **備份** | 使用 Snapshot 至 S3：`PUT _snapshot/my_backup` |
| **監控** | 部署 Metricbeat → Elasticsearch，Kibana 監控叢集健康 |
| **索引管理** | ILM 策略：Hot → Warm → Delete (30 天) |
| **效能** | 生產建議 16GB+ Heap，SSD 磁碟，3 Master + 2 Data 分離 |
| **擴充** | 前置 **Kafka 蓄洪池**，避免 Logstash 直連 DB 遺失資料 |
| **升級** | 滾動升級：停一節點 → 升級 → 加入叢集 |

---

## 九、常見問題除錯

| 問題 | 解決方式 |
|------|---------|
| `max virtual memory areas vm.max_map_count` | 確認 `sysctl` 已套用 |
| 叢集變黃/紅 | 檢查 `9300` 是否互通：`telnet 192.168.10.201 9300` |
| Kibana 連不到 ES | 確認 `ELASTICSEARCH_HOSTS` 與密碼正確 |
| Logstash 無輸出 | 檢查 pipeline 語法：`docker logs logstash` |

---

**完成！**  
您已成功部署 **三節點高可用 ELK 叢集**，支援：
- 跨主機分片與副本  
- Kibana 視覺化  
- Logstash 即時 ETL  
- 安全認證（elastic 超管）

> **專業建議**：  
> 後續整合 **Filebeat** 收集 Syslog，搭配 **Kibana Alerting** 實現異常監控。  
> 考慮使用 **ECK (Elastic Cloud on Kubernetes)** 進行容器化管理。
