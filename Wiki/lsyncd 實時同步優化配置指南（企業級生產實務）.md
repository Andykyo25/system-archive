# **lsyncd 實時同步優化配置指南（企業級生產實務）**

**目標**：  
實現 **A → B 機器實時、穩定、安全、高效** 的檔案同步，取代傳統 `cron + rsync`，支援：
- **事件驅動（inotify）**
- **多路徑同步**
- **SSH 密鑰認證（免密碼）**
- **同步日誌與監控**
- **故障自動恢復**

---

## **lsyncd vs rsync 核心差異（一圖秒懂）**

| 項目 | **lsyncd** | **rsync** |
|------|------------|-----------|
| **觸發方式** | 實時（inotify 事件） | 手動或定時（cron） |
| **同步頻率** | 即時（秒級） | 分鐘/小時級 |
| **資源佔用** | 低（事件驅動） | 高（全量掃描） |
| **適用場景** | 靜態資源、程式碼、配置 | 備份、遷移 |
| **底層工具** | 封裝 rsync | 本身 |

> **結論**：`lsyncd = inotify + rsync + 守護進程`

---

## 優化後 lsyncd 配置（`/etc/lsyncd.conf`）

```lua
-- ========================================
-- lsyncd 企業級配置（A → B 實時同步）
-- 支援：SSH 密鑰、多路徑、排除、壓縮、限速、監控
-- ========================================

settings {
    -- 日誌配置
    logfile     = "/var/log/lsyncd/lsyncd.log",
    statusFile  = "/var/log/lsyncd/lsyncd-status.log",
    statusInterval = 10,
    
    -- 進階參數
    maxProcesses = 5,           -- 最大並行同步進程
    maxDelays    = 10,          -- 事件累積上限
    insist       = true,        -- 故障後持續重試
    nodaemon     = false,
    
    -- inotify 優化
    inotifyMode  = "CloseWrite or Modify",
    maxEvents    = 2048
}

-- ========================================
-- 同步任務 1：靜態資源（/var/static → B 機器）
-- ========================================
sync {
    default.rsyncssh,
    
    -- 來源目錄
    source = "/var/static/",
    
    -- 目標：user@host::module
    host   = "dp3-sync-002",
    target = "root@dp3-sync-002::static",
    
    -- 同步策略
    delete = "running",        -- 同步中刪除（安全）
    delay  = 15,               -- 事件合併延遲（秒）
    
    -- 排除規則（支援正則）
    exclude = {
        ".git/",
        ".idea/",
        "*.tmp",
        "*.log",
        "*.zip",
        "*.swp",
        ".*~"                  -- 隱藏備份檔
    },
    
    -- rsync 參數優化
    rsync = {
        binary     = "/usr/bin/rsync",
        archive    = true,
        compress   = true,
        verbose    = true,
        bwlimit    = 20000,    -- 20MB/s 限速
        acls       = true,
        xattrs     = true,
        perms      = true,
        owner      = true,
        group      = true,
        _extra     = {"--partial", "--partial-dir=.rsync-partial"}
    },
    
    -- SSH 密鑰認證
    ssh = {
        identityFile = "/root/.ssh/id_rsa_lsyncd",
        port         = 22
    },
    
    -- 啟動前初始化（首次全量同步）
    init = true
}

-- ========================================
-- 同步任務 2：程式碼目錄（可選）
-- ========================================
-- sync {
--     default.rsyncssh,
--     source = "/var/www/html/",
--     host   = "dp3-sync-002",
--     target = "root@dp3-sync-002::webroot",
--     delete = true,
--     delay  = 10,
--     exclude = { "*.log", ".git/", "node_modules/" },
--     rsync = { archive = true, compress = true },
--     ssh = { identityFile = "/root/.ssh/id_rsa_lsyncd" }
-- }
```

---

## 必備前置作業（A 機器操作）

### 1. 安裝 lsyncd

```bash
yum install -y lsyncd
# 或
apt install lsyncd -y
```

### 2. 建立 SSH 免密碼登入（**強烈推薦**）

```bash
# A 機器生成密鑰
ssh-keygen -t rsa -b 4096 -f /root/.ssh/id_rsa_lsyncd -N ""

# 複製公鑰到 B 機器
ssh-copy-id -i /root/.ssh/id_rsa_lsyncd.pub root@20.206.203.234

# 測試
ssh -i /root/.ssh/id_rsa_lsyncd root@dp3-sync-002 "ls /var/static/"
```

### 3. B 機器 rsyncd 配置（`/etc/rsyncd.conf`）

```conf
uid = root
gid = root
use chroot = yes
pid file = /var/run/rsyncd.pid
log file = /var/log/rsyncd.log

[static]
    path = /var/static/
    comment = Static files sync
    read only = no
    write only = no
    hosts allow = 20.206.203.234  # A 機器 IP
    hosts deny = *
    list = false
```

```bash
# 啟動 rsync daemon
rsync --daemon
echo "rsync --daemon" >> /etc/rc.local
```

### 4. 防火牆開放

```bash
# B 機器
firewall-cmd --add-port=873/tcp --permanent
firewall-cmd --reload
```

---

## 啟動與驗證

```bash
# 建立日誌目錄
mkdir -p /var/log/lsyncd
touch /var/log/lsyncd/lsyncd.{log,status.log}
chown lsyncd:lsyncd /var/log/lsyncd -R

# 啟動服務
systemctl enable lsyncd
systemctl restart lsyncd

# 檢查狀態
systemctl status lsyncd
journalctl -u lsyncd -f
```

### 測試同步

```bash
# A 機器建立測試檔
echo "test $(date)" > /var/static/test_$(date +%s).txt

# B 機器檢查
ssh root@dp3-sync-002 "ls -la /var/static/ | grep test"
```

---

## 監控與告警（進階）

### 1. Zabbix 監控 lsyncd

```bash
# UserParameter
echo 'UserParameter=lsyncd.status,systemctl is-active lsyncd' >> /etc/zabbix/zabbix_agent2.d/lsyncd.conf
echo 'UserParameter=lsyncd.delay,cat /var/log/lsyncd/lsyncd-status.log | grep -o "delayed.*" | wc -l' >> /etc/zabbix/zabbix_agent2.d/lsyncd.conf

systemctl restart zabbix-agent2
```

### 2. 日誌輪替

```bash
cat > /etc/logrotate.d/lsyncd <<EOF
/var/log/lsyncd/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    create 640 root root
    postrotate
        systemctl reload lsyncd >/dev/null 2>&1 || true
    endscript
}
EOF
```

---

## 常見問題與優化

| 問題 | 解決方案 |
|------|----------|
| **同步延遲** | 降低 `delay` 或提高 `maxProcesses` |
| **CPU 過高** | 增加 `delay = 30`，避免頻繁觸發 |
| **權限錯誤** | 確保 B 機器 `path` 目錄 `chown root:root` |
| **斷線重連** | `insist = true` 自動重試 |
| **大量小檔案** | 啟用 `--whole-file=false` |

---

## SE/DevOps 最佳實務

| 項目 | 建議 |
|------|------|
| **SSH 密鑰** | 專用 `id_rsa_lsyncd`，定期輪替 |
| **rsync daemon** | 僅允許 A 機器 IP |
| **日誌監控** | Grafana + Loki 視覺化 |
| **備援方案** | 搭配 `csync2` 或 `syncthing` |
| **多路徑** | 每個 `sync {}` 區塊獨立配置 |
| **測試環境** | 先在 staging 驗證 |

---

**完成！**  
您已部署 **企業級實時同步方案**，具備：
- 秒級同步
- 免密碼 SSH
- 自動重試
- 完整監控
- 高可用架構

> **專業提醒**：  
> 生產環境建議搭配 **rsync daemon + SSH 雙模式**，或使用 **lsyncd + systemd watchdog** 實現高可用。
