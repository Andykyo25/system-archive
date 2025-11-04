# Docker Image 自動清理腳本（保留最新 3 版）

**適用情境**：  
GitLab Runner 每次建置都會產生新 Docker Image，導致 **磁碟空間爆炸**。  
本腳本自動 **清理舊版 Image**，**每個 Repository 保留最新 3 個版本**，適用於私有 Registry（如 `192.168.10.209:80`）。

> **SE/DevOps 最佳實務**：  
> - 搭配 **Cron 排程** 每日自動執行  
> - 記錄清理日誌，方便除錯與稽核  
> - 支援多 Repository 自動處理

---

## 第一步：建立清理腳本

> **路徑**：`/home/ai/gitlab-runner/cleanup_docker_images.sh`  
> **主機**：`w1`（192.168.10.201）

```bash
#!/bin/bash

# ========================================
# Docker Image 自動清理腳本
# 功能：每個 Repository 保留最新 3 個 Image，其餘強制刪除
# 適用：GitLab Runner 建置產生的私有映像
# ========================================

set -euo pipefail

# 設定日誌檔案
LOG_FILE="/var/log/docker_cleanup.log"
REGISTRY_PREFIX="192.168.10.209:80"
KEEP_COUNT=3

# 記錄開始時間
echo "==========================================" | tee -a "$LOG_FILE"
echo "Docker Image Cleanup 開始: $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"
echo "保留最新 $KEEP_COUNT 個版本，清理前綴: $REGISTRY_PREFIX" | tee -a "$LOG_FILE"

# 取得所有符合前綴的 Repository
REPOSITORIES=$(docker images --format "{{.Repository}}" | grep "^$REGISTRY_PREFIX" | sort -u)

if [[ -z "$REPOSITORIES" ]]; then
  echo "未發現符合 $REGISTRY_PREFIX 的映像，清理結束。" | tee -a "$LOG_FILE"
  exit 0
fi

# 處理每個 Repository
for repo in $REPOSITORIES; do
  echo "正在處理 Repository: $repo" | tee -a "$LOG_FILE"

  # 取得該 repo 的所有 Image，按建立時間降冪排序（最新在前）
  IMAGE_LIST=$(docker images --format "{{.ID}}\t{{.Tag}}\t{{.CreatedAt}}" \
    --filter "reference=$repo:*" | sort -r -k3)

  if [[ -z "$IMAGE_LIST" ]]; then
    echo "  無映像可處理。" | tee -a "$LOG_FILE"
    continue
  fi

  # 取出要刪除的 Image ID（第 4 個之後）
  IMAGES_TO_DELETE=$(echo "$IMAGE_LIST" | tail -n +$((KEEP_COUNT + 1)) | awk '{print $1}')

  if [[ -n "$IMAGES_TO_DELETE" ]]; then
    DELETE_COUNT=$(echo "$IMAGES_TO_DELETE" | wc -l)
    echo "  發現 $DELETE_COUNT 個舊版映像，將刪除：" | tee -a "$LOG_FILE"
    echo "$IMAGE_LIST" | head -n $KEEP_COUNT | awk '{print "    [保留] " $1 "  " $2 "  " $3}' | tee -a "$LOG_FILE"
    echo "$IMAGE_LIST" | tail -n +$((KEEP_COUNT + 1)) | awk '{print "    [刪除] " $1 "  " $2 "  " $3}' | tee -a "$LOG_FILE"

    # 強制刪除（-f 忽略容器使用中錯誤）
    echo "$IMAGES_TO_DELETE" | xargs -r docker rmi -f 2>&1 | tee -a "$LOG_FILE"
  else
    echo "  少於 $KEEP_COUNT 個，無需清理。" | tee -a "$LOG_FILE"
  fi
done

echo "Docker Image 清理完成: $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"
echo "==========================================" | tee -a "$LOG_FILE"
echo | tee -a "$LOG_FILE"
```

---

## 第二步：設定執行權限與日誌目錄

```bash
# 建立日誌目錄與檔案
sudo mkdir -p /var/log
sudo touch /var/log/docker_cleanup.log
sudo chown root:root /var/log/docker_cleanup.log
sudo chmod 644 /var/log/docker_cleanup.log

# 移動腳本並設定權限
sudo mv /home/ai/gitlab-runner/cleanup_docker_images.sh /usr/local/bin/cleanup_docker_images.sh
sudo chmod +x /usr/local/bin/cleanup_docker_images.sh
```

---

## 第三步：設定 Cron 每日自動執行

```bash
sudo crontab -e
```

加入以下排程：

```cron
# 每日凌晨 3:00 執行 Docker Image 清理，保留最新 3 版
0 3 * * * /usr/local/bin/cleanup_docker_images.sh >> /var/log/docker_cleanup.log 2>&1
```

> **建議**：可先手動測試：
> ```bash
> sudo /usr/local/bin/cleanup_docker_images.sh
> ```

---

## 第四步：驗證清理結果

```bash
# 查看目前映像（按時間排序）
docker images --format "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}" | \
  grep "192.168.10.209" | sort -k3 -r | head -20
```

**預期**：每個 Repository 最多顯示 **3 行**（最新 3 版）

---

## 進階功能建議

| 功能 | 實作方式 |
|------|---------|
| **Email 通知** | 加入 `mail` 指令發送日誌摘要 |
| **Slack 通知** | 使用 `curl` 發送到 Webhook |
| **Dangling Image 清理** | 加入 `docker image prune -f` |
| **磁碟使用率警報** | `df -h` 檢查 `/var/lib/docker` |
| **排除特定映像** | 加入 `EXCLUDE_REPOS` 陣列 |

---

## SE/DevOps 最佳實務

| 項目 | 建議 |
|------|------|
| **日誌輪替** | 使用 `logrotate` 管理 `/var/log/docker_cleanup.log` |
| **權限最小化** | 腳本僅需 `docker` 群組權限 |
| **測試環境驗證** | 先在 staging 測試清理邏輯 |
| **GitLab CI 整合** | 在 `.gitlab-ci.yml` 加入 `image: cleanup` 階段 |
| **監控空間** | Grafana 監控 `docker_info{container_filesystem_usage}` |

---

**完成！**  
您已成功部署：
- **自動清理舊版 Docker Image**  
- **保留最新 3 版**  
- **每日凌晨執行 + 日誌記錄**  
- **安全、可稽核、易維護**

> **專業提醒**：  
> 生產環境建議搭配 **Harbor / Nexus** 作為 Registry，啟用 **自動清理策略（Retention Policy）**，實現雙重保障。
