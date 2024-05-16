# Prometheuse告警串接Dayu全流程
手把手教學 Prometheus 架設從 0 到有，並將告警發送至 dayu di oncall


## 第一步 - 建立容器
這邊使用 docker compose 建立 **Prometheus Server**, **Grafana**, 以及 **node exporter**
- network_mode: host 則不需要寫 port
- user: root 否則部份文件會有權限不足問題
- 建議 data 都印射出來，不然重 build 資料就沒了
## <span id="docker-compose.yaml">docker-compose.yaml 內容</span>
```bash
version: '3.1'
services:

  prometheus:
    container_name: prometheus
    image: bitnami/prometheus:2.51.1
    user: root
    volumes: 
      - '/var/app/prometheus/data:/opt/bitnami/prometheus/data'
      - '/var/app/prometheus/conf:/opt/bitnami/prometheus/conf'
      - '/etc/localtime:/etc/localtime:ro'
    command:
      - '--config.file=/opt/bitnami/prometheus/conf/prometheus.yml'
      - '--web.enable-lifecycle'
    network_mode: host
#    ports:
#      - "9090:9090"

  grafana:
    container_name: grafana
    image: grafana/grafana:10.4.1
    network_mode: host
    user: root
    volumes:
      - '/var/app/grafana/data:/var/lib/grafana'
#    ports:
#      - "3000:3000"

  node_exporter:
    container_name: node_exporter
    image: quay.io/prometheus/node-exporter:latest
    command:
      - '--path.rootfs=/host'
    network_mode: host
    pid: host
    restart: unless-stopped
    volumes:
      - '/:/host:ro,rslave'
#    ports:
#      - "9100:9100"
```
確認容器都起來後，即可 ip:端口 訪問試試
> 請確保端口都有開
{.is-warning}

## 第二步 - 寫好你的 Prometheus.yml
這份檔案攸關你的監控來源以及你告警規則的配置要吃哪一份文件
- global 為 全域設置
- alertmanager configuration 稍後會安裝該服務，此處為到時候要吃的 rules 文件
- job name 配置你要監控的來源（這邊是抓 consle 裡的 java 資料）
```bash
# my global config
global:
  scrape_interval: 15s # Set the scrape interval to every 15 seconds. Default is every 1 minute.
  evaluation_interval: 15s # Evaluate rules every 15 seconds. The default is every 1 minute.
  # scrape_timeout is set to the global default (10s).

# Alertmanager configuration
alerting:
  alertmanagers:
    - static_configs:
        - targets:
          - localhost:9093

# Load rules once and periodically evaluate them according to the global 'evaluation_interval'.
rule_files:
   - "rules.yml"

# A scrape configuration containing exactly one endpoint to scrape:
# Here it's Prometheus itself.
scrape_configs:
  # The job name is added as a label `job=<job_name>` to any timeseries scraped from this config.
  - job_name: "prometheus"

    # metrics_path defaults to '/metrics'
    # scheme defaults to 'http'.

    static_configs:
      - targets: ["localhost:9090"]


  - job_name: node
    static_configs:
      - targets: ["localhost:9100"]


  - job_name: **http_sd
    metrics_path: '_monitor/prometheus'
    basic_auth:
      username: ******
      password: ******
    relabel_configs:
      - source_labels: [__meta_serviceName]
        # remove the serviceName when the name is: gateway
        action: replace
        regex: gateway
        replacement: ""
        target_label: __meta_serviceName
      - source_labels: [__meta_serviceName,__metrics_path__]
        # concat the serviceName and the metricsPath to the new path
        separator: "/"
        target_label: __metrics_path__
        
   http_sd_configs:
      - url: "http://console.*******/_monitor/nacos/sd?domain=console.******"
        basic_auth:
          username: *****
          password: *****
```

## 第三步 - Alertmanager 容器建立
- 建立 alertmanager docker compose
- telegram.tmpl 是因為要客製化傳去 TG 的告警內容，所以此處需要先寫好

```bash
version: '3.1'

services:
  alertmanager:
    image: prom/alertmanager:v0.27.0
    user: root
    network_mode: host
    ports:
      - "9093:9093"
    command:
      - '--config.file=/alertmanager.yml'
    volumes:
      - /var/app/alertmanager/data:/alertmanager/data
      - /var/app/alertmanager/conf/alertmanager.yml:/alertmanager.yml
      - /var/app/alertmanager/conf/telegram.tmpl:/etc/telegram.tmpl
      - /etc/localtime:/etc/localtime:ro
    restart: always
```

## 第四步 - 建立告警並發送到 Telegram
- 編輯 alertmanager.yml 將告警要送去哪裡的規則寫好
- telegram 的部份要準備好 bot token 以及 chat_id （頻道要先創建好以及產出需要的東西）
- 呈上，不另外教學，請自行 google

```bash
global:
  resolve_timeout: 5m

route:
  receiver: 'telegram'
  routes:
  - receiver: 'telegram'
    continue: true

receivers:
  - name: 'telegram'
    telegram_configs:
    - bot_token: 97460:AAGj98-LUc6KlUV***********
      api_url: https://api.telegram.org
      chat_id: -10020*******

templates:
- '/etc/telegram.tmpl'
```

## 第五步 - 定義 telegram 告警內容
- 剛剛上面已經有提到，telegram.tmpl 會是我們的自定義告警內容
- 記得路徑要跟剛剛 yml 對上

```bash
{{ define "telegram.default.message" }}
{{ if gt (len .Alerts.Firing) 0 }}
🔥Alerts Firing🔥 :
- Alertname: {{ .CommonLabels.alertname }}
- Application: {{ .CommonLabels.application }}
- Instance:  {{ .CommonLabels.instance }}
- Job:  {{ .CommonLabels.job }}
- Serverity: {{ .CommonLabels.severity }}
#- _{{ .CommonAnnotations.description }}_
- Summary: {{ .CommonAnnotations.summary }}
{{ end }}

{{ if gt (len .Alerts.Resolved) 0 }}
✅Alerts Resolved✅ :
- Alertname: {{ .CommonLabels.alertname }}
- Application: {{ .CommonLabels.application }}
- Instance:  {{ .CommonLabels.instance }}
- Job:  {{ .CommonLabels.job }}
- Serverity: {{ .CommonLabels.severity }}
#- _{{ .CommonAnnotations.description }}_
- Summary: {{ .CommonAnnotations.summary }}
{{ end }}
{{ end }}
```

## 第六步 - 建立告警規則
- 編輯 rules.yml 檔 （檔名是上面你 prmetheus.yml 定義 alertmanager rules 的檔名）
- 創建好後，該規則若條件觸發，就會接到你的 alertmanager 並送至 TG

```bash
groups:
- name: 'rules'
  rules:

  - alert: '[DI-告警] 負載過高測試告警'
    expr: system_load_average_1m{application="activity-admin-api",job="dp_dp02_sd"} > 3
    for: 5s
    labels:
      severity: disaster
      application: activity-admin-api
    annotations:
      summary: test
```
## 第七步 - 建立 webhook
- 先下載安裝 webhook （需要 go 語言）
- 都安裝好後，準備好要觸發的腳本，建立並配置 hook.yml 檔案來指定你的 hook  要執行什麼事
- id 自己取名，等等要用
- execute-command 就是 腳本的位置
- command-working-directory 是你 webhook 的位置
```bash
- id: dayu-webhook
  execute-command: "/var/app/prometheus/conf/dayu.sh"
  command-working-directory: "/root/webhook"
```
## 第八步 - 建立 alertmanager webhook 規則
- 回到剛剛配置 telegram那份文件 alertmanager.yml
- 新增上 hook 的配置
- 如果你有一個以上的接收者（如下），route & receivers 請照順序寫好，寫反了不會生效
- url 是 宿主機內網IP以及預設9000端口 /hooks/ 你的 id
```bash
global:
  resolve_timeout: 5m

route:
  receiver: 'telegram'
  routes:
  - receiver: 'telegram'
    continue: true
  - receiver: 'hook'
    continue: true

receivers:
  - name: 'telegram'
    telegram_configs:
    - bot_token: 97460:AAGj98-LUc6KlUV***********
      api_url: https://api.telegram.org
      chat_id: -10020*******

  - name: 'hook'
    webhook_configs:
    - url: 'http://10.122.**.**:9000/hooks/dayu-webhook'

templates:
- '/etc/telegram.tmpl'
```

## 第九步 - run webhook 並讓後台執行
- 記得用後台執行，不然要一直掛在那個畫面
- 到 webhook 資料夾，下指令
`./webhook -hooks hooks.yaml -verbose &`
> 接著就靜待奇蹟發生，以上解說完畢。無法寫得很詳細，還是需要一點時間自行研究，但至少省很多走歪路的時間