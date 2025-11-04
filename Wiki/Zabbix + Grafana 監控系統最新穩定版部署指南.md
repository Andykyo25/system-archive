# **Zabbix + Grafana 監控系統最新穩定版部署指南（2025 推薦）**

**最新穩定版本（截至 2025/10/31）**：

| 組件 | 推薦版本 | 映像 |
|------|----------|------|
| **Zabbix Server** | **6.0.33** (LTS) | `zabbix/zabbix-server-mysql:alpine-6.0.33` |
| **Zabbix Proxy** | **6.0.33** (LTS) | `zabbix/zabbix-proxy-sqlite3:alpine-6.0.33` |
| **Zabbix Agent2** | **6.0.33** | `zabbix-agent2-6.0.33-1.el7.x86_64.rpm` |
| **Grafana** | **11.2.0** (LTS) | `grafana/grafana:11.2.0` |

> **為何選 6.0.33？**  
> - **LTS 長期支援**，穩定性高  
> - **Agent2 完全成熟**，支援 Plugin 架構  
> - **Web UI 大幅優化**，支援深色模式、多語言  
> - **效能提升 30%+**，適合萬級主機

---

## 統一目錄結構（強烈建議）

```bash
/opt/zabbix/
├── server/     → docker-compose + conf + data
├── proxy/
├── agent/
└── grafana/
```

```bash
sudo mkdir -p /opt/zabbix/{server,proxy,agent,grafana}/{deploy,conf,data}
```

---

## Zabbix Server 6.0.33 部署（高可用優化）

### `docker-compose.yml`（`/opt/zabbix/server/deploy/`）

```yaml
version: "3.9"

services:
  mysql:
    image: mariadb:10.11
    container_name: zabbix-mysql
    restart: always
    command:
      - mysqld
      - --max_connections=2000
      - --innodb_buffer_pool_size=2G
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_bin
    environment:
      MYSQL_ROOT_PASSWORD: ZbxRootPwd2025!
      MYSQL_DATABASE: zabbix
      MYSQL_USER: zabbix
      MYSQL_PASSWORD: ZbxUserPwd2025!
    volumes:
      - /opt/zabbix/server/data/mysql:/var/lib/mysql
      - /etc/localtime:/etc/localtime:ro
    ports:
      - "3306:3306"
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-pZbxRootPwd2025!"]
      interval: 10s
      timeout: 5s
      retries: 5

  zabbix-server:
    image: zabbix/zabbix-server-mysql:alpine-6.0.33
    container_name: zabbix-server
    restart: always
    depends_on:
      mysql:
        condition: service_healthy
    environment:
      ZBX_CACHESIZE: 4G
      ZBX_HISTORYCACHESIZE: 2G
      ZBX_TRENDCACHESIZE: 2G
      ZBX_VALUECACHESIZE: 2G
      DB_SERVER_HOST: mysql
      MYSQL_USER: zabbix
      MYSQL_PASSWORD: ZbxUserPwd2025!
      MYSQL_DATABASE: zabbix
    volumes:
      - /opt/zabbix/server/conf/zabbix_server.conf:/etc/zabbix/zabbix_server.conf:ro
      - /opt/zabbix/server/data/alertscripts:/usr/lib/zabbix/alertscripts
      - /opt/zabbix/server/data/export:/var/lib/zabbix/export
      - /opt/zabbix/server/data/modules:/var/lib/zabbix/modules
      - /etc/localtime:/etc/localtime:ro
    ports:
      - "10051:10051"
    ulimits:
      nofile: 65536

  zabbix-web:
    image: zabbix/zabbix-web-nginx-mysql:alpine-6.0.33
    container_name: zabbix-web
    restart: always
    depends_on:
      - zabbix-server
    environment:
      ZBX_SERVER_HOST: zabbix-server
      DB_SERVER_HOST: mysql
      MYSQL_USER: zabbix
      MYSQL_PASSWORD: ZbxUserPwd2025!
      MYSQL_DATABASE: zabbix
      PHP_TZ: Asia/Taipei
    ports:
      - "8080:8080"
      - "8443:8443"
    volumes:
      - /etc/localtime:/etc/localtime:ro
```

---

### `zabbix_server.conf`

```conf
LogType=console
DBHost=mysql
DBName=zabbix
DBUser=zabbix
DBPassword=ZbxUserPwd2025!
DBPort=3306

# 效能優化
StartPollers=500
StartPollersUnreachable=100
StartTrappers=50
StartPingers=150
StartDiscoverers=200
StartHTTPPollers=50

CacheSize=4G
HistoryCacheSize=2G
TrendCacheSize=2G
ValueCacheSize=2G

HousekeepingFrequency=1
MaxHousekeeperDelete=5000

AlertScriptsPath=/usr/lib/zabbix/alertscripts
ExternalScripts=/usr/lib/zabbix/externalscripts
```

---

### 啟動

```bash
cd /opt/zabbix/server/deploy
docker compose up -d
```

> Web UI：`http://IP:8080`  
> 首次登入：`Admin` / `zabbix` → 立即改密碼

---

## Zabbix Proxy 6.0.33 部署

### `docker-compose.yml`

```yaml
version: '3.9'
services:
  zabbix-proxy:
    image: zabbix/zabbix-proxy-sqlite3:alpine-6.0.33
    container_name: zabbix-proxy
    restart: always
    network_mode: host
    user: "1001:0"
    volumes:
      - /opt/zabbix/proxy/conf/zabbix_proxy.conf:/etc/zabbix/zabbix_proxy.conf:ro
      - /opt/zabbix/proxy/data:/var/lib/zabbix
      - /etc/localtime:/etc/localtime:ro
    environment:
      - ZBX_HOSTNAME=zabbix-proxy-$(hostname)
```

---

### `zabbix_proxy.conf`

```conf
Server=192.168.10.201
ServerPort=10051
ProxyMode=0
Hostname=zabbix-proxy-$(hostname)
CacheSize=2G
LogType=console
DBName=/var/lib/zabbix/zabbix_proxy.db
StartPollers=300
StartPollersUnreachable=100
HousekeepingFrequency=1
ConfigFrequency=60
DataSenderFrequency=1
```

---

### 部署（jms-op）

```bash
sudo usermod -aG docker jms-op
sudo chown -R jms-op:jms-op /opt/zabbix/proxy

su - jms-op
cd /opt/zabbix/proxy/deploy
docker compose up -d
exit
```

---

## Zabbix Agent2 6.0.33 安裝

### 下載與安裝

```bash
rpm -Uvh https://repo.zabbix.com/zabbix/6.0/rhel/7/x86_64/zabbix-agent2-6.0.33-1.el7.x86_64.rpm
```

---

### `/etc/zabbix/zabbix_agent2.conf`

```conf
PidFile=/var/run/zabbix/zabbix_agent2.pid
LogFile=/var/log/zabbix/zabbix_agent2.log
LogFileSize=10
DebugLevel=3

Server=192.168.10.201
ServerActive=192.168.10.201
HostnameItem=system.hostname

BufferSend=5
BufferSize=100
RefreshActiveChecks=60
Timeout=30

# Docker 監控
Plugins.Docker.Socket=/var/run/docker.sock
Plugins.Docker.Timeout=30

# 系統優化
AllowKey=system.run[*]
UnsafeUserParameters=1
```

---

### 啟動與權限

```bash
usermod -aG docker zabbix
chown -R jms-op:jms-op /etc/zabbix

systemctl enable --now zabbix-agent2
systemctl status zabbix-agent2
```

---

## Grafana 11.2.0 部署

### `docker-compose.yml`

```yaml
version: '3.9'
services:
  grafana:
    image: grafana/grafana:11.2.0
    container_name: grafana
    restart: always
    ports:
      - "3000:3000"
    volumes:
      - grafana-data:/var/lib/grafana
      - /etc/localtime:/etc/localtime:ro
    environment:
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=Grafana2025!
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_AUTH_ANONYMOUS_ENABLED=false
      - GF_SERVER_ROOT_URL=http://grafana.company.com
    user: "472:0"

volumes:
  grafana-data:
```

---

### 啟動

```bash
cd /opt/zabbix/grafana/deploy
docker compose up -d
```

> 登入：`http://IP:3000`  
> 帳號：`admin` / `Grafana2025!`

---

## 防火牆與安全

```bash
firewall-cmd --add-port={8080,8443,10051,3000}/tcp --permanent
firewall-cmd --reload
```

---

## 自動備份腳本（每日 2AM）

```bash
#!/bin/bash
BACKUP_DIR="/backup/zabbix/$(date +%Y%m%d)"
mkdir -p $BACKUP_DIR

# Zabbix DB
docker exec zabbix-mysql mysqldump -u zabbix -p'ZbxUserPwd2025!' zabbix > $BACKUP_DIR/zabbix.sql

# Grafana
docker cp grafana:/var/lib/grafana $BACKUP_DIR/grafana-data

# 保留 14 天
find /backup/zabbix -mtime +14 -exec rm -rf {} \;
```

```bash
chmod +x /opt/zabbix/backup.sh
echo "0 2 * * * /opt/zabbix/backup.sh >> /var/log/zabbix_backup.log 2>&1" | crontab -
```

---

## 新功能亮點（6.0.33）

| 功能 | 說明 |
|------|------|
| **Agent2 Plugin** | 支援 `docker`, `kubernetes`, `mqtt` |
| **WebHook 2.0** | 支援自訂 Header / JSON |
| **TimescaleDB 支援** | 歷史資料分片 |
| **暗色主題** | UI 更現代 |
| **API Token** | 取代密碼登入 |

---

**完成！**  
您已部署 **2025 年最新穩定監控系統**，具備：
- **LTS 長期支援**
- **效能提升 30%+**
- **Agent2 完整支援**
- **Grafana 11 原生體驗**
- **自動備份 + 安全部署**

> **專業建議**：  
> 後續整合 **Zabbix Proxy 高可用（Active-Active）** + **Grafana Loki** 作為日誌備援。
