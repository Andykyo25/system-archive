# Ubuntu EC2 建立個人帳號與 SSH PEM 憑證登入教學

**適用情境**：  
在 Ubuntu EC2 Server 建立新使用者帳號，並設定 **SSH 私鑰（PEM）登入**，實現安全、無密碼登入與帳號隔離管理。  
> 使用者名稱以 `username` 替代（請替換為實際名稱）

---

## 一、管理者端（在 EC2 伺服器操作）

> 預設以 `ubuntu` 帳號登入 EC2（或具 `sudo` 權限之帳號）

---

### 1. 建立新使用者帳號

```bash
sudo adduser username
```

> 系統會提示設定密碼與基本資訊（可跳過或填寫）

---

### 2. （可選）授予 `sudo` 權限

如該帳號需具管理權限：

```bash
sudo usermod -aG sudo username
```

---

### 3. 建立 SSH 目錄與設定權限

```bash
sudo mkdir -p /home/username/.ssh
sudo chmod 700 /home/username/.ssh
sudo chown username:username /home/username/.ssh
```

---

### 4. 在伺服器上為使用者生成 RSA 金鑰（PEM 格式）

```bash
sudo -u username ssh-keygen -t rsa -b 4096 -m PEM -f /home/username/.ssh/username -C "username@ec2"
```

**生成檔案**：
- `/home/username/.ssh/username`       ← **私鑰（PEM）**，需安全交付給使用者
- `/home/username/.ssh/username.pub`   ← 公鑰

> **提示**：直接按 `Enter` 跳過 passphrase（避免互動式登入麻煩）

---

### 5. 將公鑰加入 `authorized_keys`

```bash
sudo -u username bash -c 'cat /home/username/.ssh/username.pub >> /home/username/.ssh/authorized_keys'
sudo chmod 600 /home/username/.ssh/authorized_keys
sudo chown username:username /home/username/.ssh/authorized_keys
```

---

### 6. 驗證 SSH 設定允許金鑰登入

檢查 `/etc/ssh/sshd_config`：

```bash
sudo grep -E "^(PubkeyAuthentication|PasswordAuthentication)" /etc/ssh/sshd_config
```

**應確認以下設定（若無則新增或取消註解）**：

```conf
PubkeyAuthentication yes
PasswordAuthentication no   # 建議關閉密碼登入，提升安全性
```

> 若有修改，**重啟 SSH 服務**：

```bash
sudo systemctl restart ssh
```

---

### 7. 將私鑰安全匯出給使用者

> **請勿複製貼上私鑰內容**（易造成換行錯誤）

使用 `scp` 或 WinSCP 從伺服器下載：

```bash
scp ubuntu@<EC2公網IP>:/home/username/.ssh/username ./username.pem
```

> 建議下載後立即設定本地檔案權限：

```bash
chmod 400 username.pem
```

---

### 8. （可選）清理伺服器內的私鑰副本

為避免私鑰留在伺服器，交付後立即刪除：

```bash
sudo rm /home/username/.ssh/username
```

> 保留 `.pub` 與 `authorized_keys` 即可

---

## 二、使用者端（本地電腦登入測試）

### 使用 SSH PEM 登入

```bash
ssh -i username.pem username@<EC2公網IP>
```

**成功範例輸出**：
```
Welcome to Ubuntu 22.04.4 LTS (GNU/Linux x.x.x-x-generic x86_64)
...
username@ip-xxx-xxx-xxx-xxx:~$
```

---

## 三、驗證與除錯建議

| 指令 | 用途 |
|------|------|
| `ssh -i username.pem -v username@<IP>` | 詳細除錯模式 |
| `sudo tail -f /var/log/auth.log` | 查看 SSH 登入日誌 |
| `ls -la /home/username/.ssh/` | 確認檔案權限正確 |

**常見錯誤**：
- `Permission denied (publickey)` → 檢查 `authorized_keys` 權限或公鑰內容
- `UNPROTECTED PRIVATE KEY FILE` → 本地 `chmod 400 username.pem`
- `Server refused our key` → 確認 `PubkeyAuthentication yes`

---

## 四、安全最佳實務（SE/DevOps 建議）

| 項目 | 建議 |
|------|------|
| **禁用密碼登入** | `PasswordAuthentication no` |
| **使用 4096-bit RSA 或 Ed25519** | 更強加密 |
| **私鑰交付** | 使用加密通道（SCP/SFTP）或暫時性下載連結 |
| **定期輪替金鑰** | 每 3~6 個月更新一次 |
| **限制來源 IP** | Security Group 僅開放信任 IP |
| **啟用 Fail2Ban** | 防暴力破解（`sudo apt install fail2ban`） |

---

**完成！**  
您已成功為 `username` 建立安全、無密碼、基於 PEM 私鑰的 SSH 登入機制。

> **專業提醒**：  
> 生產環境建議搭配 **AWS Systems Manager Session Manager** 或 **Bastion Host + Just-In-Time 存取**，進一步強化安全控管。
