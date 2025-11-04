# EKS Node Wireshark 封包抓取與自動上傳 S3 教學

**適用情境**：  
針對 EKS 節點（EC2 Node）抓取特定 NodePort 服務（如 `smartfds-gateway:31161`）流量，自動時間輪檔、上傳至 S3 並控制 S3 檔案保留數量。

---

## 一、目的

- 在 EKS 節點直接監控 ALB → NodePort 的 TCP/HTTP 封包  
- 以時間輪檔方式持續抓取（不影響服務）  
- 自動上傳封包至 S3  
- 自動控制 S3 只保留最新 N 個檔案  

---

## 二、系統需求

| 項目 | 內容 |
|------|------|
| **作業系統** | Amazon Linux 2 / 2023 / Ubuntu |
| **權限** | root 或具 `sudo` 權限的使用者 |
| **工具** | `tcpdump`, `awscli`, `timeout`, `bash` |
| **IAM 權限** | 需允許 `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` |

---

## 三、部署步驟

### 1. 建立工作目錄
```bash
sudo mkdir -p /usr/local/bin
sudo mkdir -p /tmp/alb_pcap
```

### 2. 建立腳本 `/usr/local/bin/tcpdump-s3.sh`
```bash
sudo tee /usr/local/bin/tcpdump-s3.sh > /dev/null <<'EOF'
#!/bin/bash
# by Andy
S3_BUCKET="veri-id-debug"           # S3 bucket 名稱
S3_PREFIX=""                        # 可留空或指定如 "pcap/"，結尾不用加 /
PORT=31161                          # 要抓的 NodePort
SAVE_DIR="/tmp/alb_pcap"            # 本地暫存目錄
ROTATE_SEC=60                       # 每幾秒切一次新檔
UPLOAD_INTERVAL=30                  # 每隔幾秒掃描上傳
DELETE_AFTER_HOURS=3                # 本地檔保留時限（小時）
MAX_S3_FILES=50                     # S3 端僅保留最新 N 檔
LOG_FILE="/var/log/tcpdump_s3.log"

mkdir -p "$SAVE_DIR"

# === [1. 安裝依賴套件] ===
if ! command -v tcpdump >/dev/null 2>&1; then
  (yum install -y tcpdump awscli 2>/dev/null) || \
  (dnf install -y tcpdump awscli 2>/dev/null) || \
  (apt update && apt install -y tcpdump awscli -y 2>/dev/null)
fi

# === [2. 背景抓包（時間輪檔）] ===
if pgrep -af "timeout .* tcpdump .* port $PORT" >/dev/null 2>&1; then
  echo "[INFO] capture loop already running, skip start" | tee -a "$LOG_FILE"
else
  echo "[INFO] Starting time-rotating capture on port $PORT (every ${ROTATE_SEC}s)..." | tee -a "$LOG_FILE"
  nohup bash -lc '
    while true; do
      F="'"$SAVE_DIR"'/alb_trace_$(date +%Y%m%d%H%M%S).pcap"
      timeout '"$ROTATE_SEC"' tcpdump -i any -n tcp port '"$PORT"' -w "$F"
    done
  ' >> "$LOG_FILE" 2>&1 &
  echo $! > "$SAVE_DIR/capture_loop.pid"
fi

# === [3. 上傳與清理守護程式] ===
if pgrep -af "tcpdump-s3-upload-daemon" >/dev/null 2>&1; then
  echo "[INFO] uploader already running, skip start" | tee -a "$LOG_FILE"
else
  echo "[INFO] Upload & cleanup daemon started" | tee -a "$LOG_FILE"
  nohup bash -lc '
    set -o pipefail
    export DAEMON_TAG=tcpdump-s3-upload-daemon
    while true; do
      # 上傳所有已關檔案（>1 分鐘未更新）
      for file in $(find "'"$SAVE_DIR"'" -maxdepth 1 -type f -name "alb_trace_*.pcap" -mmin +1 2>/dev/null); do
        key="'"$S3_PREFIX"'"$(basename "$file")"
        echo "[UPLOAD] $(date "+%F %T") $file → s3://'"$S3_BUCKET"'/${key}"
        if aws s3 cp "$file" "s3://'"$S3_BUCKET"'/${key}"; then
          rm -f "$file"
        fi
      done

      # 清除本地過期檔案
      find "'"$SAVE_DIR"'" -type f -name "alb_trace_*.pcap" -mmin +$(( '"$DELETE_AFTER_HOURS"' * 60 )) -delete 2>/dev/null

      # 控制 S3 保留數量（只留最新 N 檔）
      TOTAL=$(aws s3api list-objects-v2 --bucket "'"$S3_BUCKET"'" --prefix "'"$S3_PREFIX"'" --query "length(Contents)" --output text 2>/dev/null)
      [ "$TOTAL" = "None" ] && TOTAL=0
      if [ "$TOTAL" -gt '"$MAX_S3_FILES"' ]; then
        TO_DELETE=$((TOTAL - '"$MAX_S3_FILES"'))
        KEYS=$(aws s3api list-objects-v2 --bucket "'"$S3_BUCKET"'" --prefix "'"$S3_PREFIX"'" \
               --query "sort_by(Contents,&LastModified)[0:${TO_DELETE}].Key" --output text 2>/dev/null)
        for key in $KEYS; do
          echo "[S3-CLEAN] delete s3://'"$S3_BUCKET"'/$key"
          aws s3api delete-object --bucket "'"$S3_BUCKET"'" --key "$key" >/dev/null
        done
      fi

      sleep '"$UPLOAD_INTERVAL"'
    done
  ' >> "$LOG_FILE" 2>&1 &
  echo $! > "$SAVE_DIR/uploader.pid"
fi
EOF
```

### 3. 賦予執行權限
```bash
sudo chmod +x /usr/local/bin/tcpdump-s3.sh
```

---

## 四、啟動與停止

### 啟動
```bash
sudo /usr/local/bin/tcpdump-s3.sh
```

### 停止
```bash
sudo pkill tcpdump || true
sudo pkill -f "timeout .* tcpdump" || true
sudo pkill -f tcpdump-s3-upload-daemon || true
sudo pkill -f tcpdump-s3.sh || true
```

### 確認是否已停止
```bash
ps -ef | egrep 'tcpdump|timeout|tcpdump-s3-upload-daemon' | grep -v egrep
```

---

## 五、結果與驗證

| 指令 | 說明 |
|------|------|
| `sudo ls -lh /tmp/alb_pcap` | 查看本地封包 |
| `sudo tail -f /var/log/tcpdump_s3.log` | 查看上傳日誌 |
| `aws s3 ls s3://veri-id-debug/` | 查看 S3 檔案 |

**檔案命名格式**：  
```
alb_trace_YYYYMMDDHHMMSS.pcap
```

每分鐘自動產生新檔。

---

## 六、本地安裝 Wireshark

有了封包，就需要軟體來解讀封包，**最大重的就是用 Wireshark**。

### 下載 Wireshark
[https://www.wireshark.org/download.html](https://www.wireshark.org/download.html)

### 使用方式
1. 從 S3 下載 `.pcap` 封包檔  
2. 打開 Wireshark → `File` → `Open` → 匯入封包  
3. 開始分析 ALB → NodePort 的流量

---

**備註**：  
- 腳本具備自動安裝 `tcpdump` 與 `awscli`  
- 支援 Amazon Linux 2 / 2023 / Ubuntu  
- 背景執行、避免重複啟動  
- S3 自動保留最新 N 個檔案，防止爆桶  
- 本地與 S3 雙重清理機制，避免磁碟與成本失控  

> **專業 SE/DevOps 建議**：  
> 生產環境建議搭配 Systemd Service 管理，避免節點重啟後失效。  
> 可進一步整合 CloudWatch Logs 監控日誌與告警。
