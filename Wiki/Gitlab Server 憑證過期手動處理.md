# GitLab Server 憑證過期手動處理教學

**適用情境**：  
GitLab 預設會在憑證即將到期前自動續期（Let's Encrypt 憑證，有效期 90 天），但偶爾因網路、率限（rate limit）或配置問題導致自動續期失敗。此時需人工介入手動續期，以避免服務中斷。  
> **注意**：手動續期僅在憑證「接近到期」（預設 30 天內）時才會實際執行。若已過期，可能需強制續期或檢查上游 Let's Encrypt 伺服器限制。建議先確認憑證狀態。

**環境假設**：  
- GitLab Omnibus 安裝（Docker 容器化部署）  
- 伺服器：Ubuntu/Debian 等 Linux  
- 憑證類型：Let's Encrypt  
- 容器名稱：`gitlab-web-1`（依實際 `docker ps` 調整）

---

## 一、目的

- 手動強制續期 GitLab 的 Let's Encrypt 憑證  
- 驗證憑證更新後生效，避免 GitLab 網頁顯示 SSL 錯誤  
- 預防自動續期失敗導致的生產環境中斷  

> **SE/DevOps 提醒**：生產環境建議監控憑證到期（使用 CloudWatch 或 GitLab CI），並定期檢查 `/var/log/gitlab/gitlab-ctl/letsencrypt.log` 日誌。

---

## 二、系統需求

| 項目 | 內容 |
|------|------|
| **權限** | root 或具 `sudo` 權限（容器內需 root） |
| **工具** | Docker, `gitlab-ctl`（GitLab 內建） |
| **網路** | 伺服器需公開可達（ports 80/443），Let's Encrypt 驗證需 HTTP 挑戰（.well-known/acme-challenge） |
| **配置** | `/etc/gitlab/gitlab.rb` 中 `letsencrypt['enable'] = true` 及 `external_url 'https://your-gitlab-domain.com'` |

> **檢查憑證狀態**：在容器外執行 `openssl s_client -connect your-gitlab-domain.com:443 -servername your-gitlab-domain.com | openssl x509 -noout -dates` 查看到期日。

---

## 三、處理步驟

### 1. 進入伺服器機器
連線到生產 GitLab 伺服器（範例：`prd_gitlab-zone-c`）：

```bash
ssh ubuntu@prd_gitlab-zone-c  # 或您的管理帳號
```

> 確保 SSH 金鑰或密碼登入正常。

### 2. 查看並進入 GitLab 容器
列出所有容器，確認 GitLab 容器名稱（通常為 `gitlab-web-1` 或類似）：

```bash
docker ps -a
```

進入容器（以 root 權限）：

```bash
docker exec -it gitlab-web-1 /bin/bash
```

> 若容器未運行，先啟動：`docker start gitlab-web-1`。

### 3. 手動執行續期指令
在容器內執行 GitLab 內建指令，手動續期憑證（每張有效 90 天）：

```bash
sudo gitlab-ctl renew-le-certs
```

**預期輸出範例**：
```
[INFO] Starting renewal for certificate: your-gitlab-domain.com
[INFO] Certificate renewed successfully.
0 resources updated
```

> **注意**：
> - 此指令僅在憑證到期前 30 天內才會實際續期。若已過期，可能顯示 "Certificate is not close to expiry" 錯誤。
> - 若失敗，檢查日誌：`gitlab-ctl tail letsencrypt` 或 `/var/log/gitlab/gitlab-ctl/letsencrypt.log`。
> - 常見錯誤：率限（Let's Encrypt 每週 50 張憑證）、防火牆阻擋端口 80/443，或 DNS 未指向伺服器。

#### 若續期失敗的進階處理（強制續期）
若標準指令無效（例如已過期），可嘗試以下（需小心，建議備份）：

1. **檢查配置**：編輯 `/etc/gitlab/gitlab.rb`，確保：
   ```
   letsencrypt['enable'] = true
   letsencrypt['contact_emails'] = ['admin@your-domain.com']  # 接收續期通知
   external_url 'https://your-gitlab-domain.com'
   ```
   然後重載：`sudo gitlab-ctl reconfigure`。

2. **強制使用 Certbot**（GitLab 內建工具）：
   ```bash
   sudo gitlab-ctl certbot-renew  # 或直接 certbot renew --force-renewal
   ```

3. **若率限問題**：暫時切換到 Let's Encrypt Staging 環境測試（修改 `gitlab.rb` 中的 `letsencrypt['enable_staging'] = true`），續期後再切回生產。

4. **手動上傳新憑證**（若 Let's Encrypt 無法使用）：
   - 從外部生成新憑證（使用 Certbot），上傳到 `/etc/gitlab/ssl/`。
   - 執行 `sudo gitlab-ctl reconfigure` 套用。

> **引用**：GitLab 官方文件指出，手動續期僅限接近到期時執行，若過期需檢查上游率限。 Stack Overflow 討論確認 `gitlab-ctl renew-le-certs` 為正確方法。

### 4. 驗證憑證是否生效
- 重新配置 GitLab（若有變更）：
  ```bash
  sudo gitlab-ctl reconfigure
  ```

- 訪問 GitLab 網頁：`https://your-gitlab-domain.com`，檢查瀏覽器鎖頭圖示，點擊查看憑證到期日（應更新為 +90 天）。

- 命令列驗證：
  ```bash
  # 在容器外
  openssl s_client -connect your-gitlab-domain.com:443 -servername your-gitlab-domain.com | openssl x509 -noout -dates
  ```

- 查看日誌確認無錯誤：
  ```bash
  sudo gitlab-ctl tail | grep -i letsencrypt
  ```

---

## 四、自動續期設定與預防

為避免未來手動介入，確認自動續期配置（在 `/etc/gitlab/gitlab.rb`）：

| 參數 | 預設值 | 建議 |
|------|--------|------|
| `letsencrypt['auto_renew']` | true | 啟用自動續期 |
| `letsencrypt['auto_renew_day_of_month']` | "*/4" | 每 4 天檢查一次（分散負載） |
| `letsencrypt['auto_renew_hour']` | "0" | 午夜執行 |
| `letsencrypt['auto_renew_minute']` | 基於 external_url hash | 隨機分鐘，避免峰值 |

套用變更：
```bash
sudo gitlab-ctl reconfigure
```

> **自動續期邏輯**：僅在到期前 30 天內觸發。 若失敗，GitLab 會發送郵件通知（需設定 `contact_emails`）。

---

## 五、常見錯誤與除錯

| 錯誤訊息 | 原因 | 解決 |
|----------|------|------|
| "Certificate is not close to expiry" | 憑證未達續期門檻 | 等待到期或強制 `--force-renewal`（若可用） |
| "Rate limit exceeded" | Let's Encrypt 率限 | 等待一週，或使用 Staging 環境測試 |
| "Connection refused" | 端口 80/443 未開 | 檢查 Security Group/Firewall，確保 .well-known 路徑可達 |
| "No such file" | 配置錯誤 | 確認 `external_url` 正確，重跑 `gitlab-ctl reconfigure` |
| 自動續期失敗但無郵件 | 未設 `contact_emails` | 新增並 reconfigure |

**日誌檢查**：
- Let's Encrypt 日誌：`/var/log/letsencrypt/letsencrypt.log`
- GitLab 錯誤：`/var/log/gitlab/nginx/gitlab_error.log | grep acme-challenge`

> **引用**：論壇討論指出，需確保 Nginx 配置允許 ACME 挑戰路徑。

---

## 六、SE/DevOps 最佳實務建議

- **監控**：整合 Prometheus + Grafana 監控憑證到期，或使用 AWS Certificate Manager（若遷移到 ALB）。
- **備份**：續期前備份 `/etc/gitlab/ssl/` 目錄。
- **測試環境**：在非生產環境模擬過期（修改系統時間）測試流程。
- **替代方案**：若頻繁失敗，考慮自簽憑證或使用 AWS ACM/Cloudflare 管理憑證。
- **安全**：確保 GitLab 版本最新（`sudo apt update && sudo apt upgrade gitlab-ee` 或 CE），修復已知漏洞。
- **自動化**：使用 Ansible 或 Terraform 管理 GitLab 配置，包含續期腳本。

**完成！**  
手動處理後，憑證應正常續期。若持續問題，建議檢查 GitLab 官方文件或開 Issue。 生產環境請在低峰期操作，避免影響使用者。
