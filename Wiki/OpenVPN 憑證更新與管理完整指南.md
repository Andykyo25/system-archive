# OpenVPN 憑證更新與管理完整指南

**適用情境**：  
OpenVPN Server 使用 **EasyRSA** 管理憑證，需定期更新 **Server / Client 憑證**（預設 3 年到期），或因安全需求提前輪替。  
本教學適用於 **Docker 部署的 OpenVPN + EasyRSA**，支援 **無密碼金鑰（nopass）**，並提供 **到期日檢查腳本**。

> **SE/DevOps 最佳實務**：  
> - 憑證輪替建議 **每年一次**  
> - 啟用 **CRL（憑證撤銷清單）** 管理失效憑證  
> - 搭配 **自動化檢查 + Alert**（如 Cron + Email）

---

## 一、環境前提

| 項目 | 路徑 |
|------|------|
| **CA 憑證** | `/etc/openvpn/pki/ca.crt` |
| **已簽發憑證** | `/etc/openvpn/pki/issued/` |
| **私鑰** | `/etc/openvpn/pki/private/` |
| **TLS 驗證檔** | `/etc/openvpn/ta.key` |
| **CSR 請求** | `/etc/openvpn/pki/reqs/` |

> 假設 OpenVPN 容器名稱：`openvpn-server`

---

## 二、Server 憑證更新流程

> 僅需在 **Server 端操作**，更新後 Client 需重新連線。

### 1. 進入 OpenVPN 容器
```bash
docker exec -it openvpn-server bash
```

### 2. 產生 Server 憑證請求（CSR）與金鑰
```bash
cd /etc/openvpn/pki
./easyrsa gen-req server-prod nopass
```

**產出**：
- `pki/private/server-prod.key`
- `pki/reqs/server-prod.req`

> 提示：`<server_name>` 建議使用 **主機域名**，如 `vpn.company.com`

### 3. 簽發 Server 憑證
```bash
./easyrsa sign-req server server-prod
```

**產出**：
- `pki/issued/server-prod.crt`

> 輸入 `yes` 確認簽發

### 4. 備份舊憑證（安全起見）
```bash
cp pki/issued/server-prod.crt pki/issued/server-prod.crt.bak
cp pki/private/server-prod.key pki/private/server-prod.key.bak
```

### 5. 更新 Server 配置（若 server.conf 指定憑證路徑）
```bash
# 確認 /etc/openvpn/server.conf 內：
cert /etc/openvpn/pki/issued/server-prod.crt
key /etc/openvpn/pki/private/server-prod.key
```

> 若使用預設路徑（`server.crt` / `server.key`），需建立符號連結：
```bash
ln -sf /etc/openvpn/pki/issued/server-prod.crt /etc/openvpn/server.crt
ln -sf /etc/openvpn/pki/private/server-prod.key /etc/openvpn/server.key
```

### 6. 重啟 OpenVPN 服務
```bash
docker restart openvpn-server
```

> **驗證**：`docker logs openvpn-server` 應無 TLS 錯誤

---

## 三、Client 憑證更新流程

> 可在 Server 端生成，交付給 Client 使用。

### 1. 進入容器
```bash
docker exec -it openvpn-server bash
```

### 2. 產生 Client 憑證請求與金鑰
```bash
cd /etc/openvpn/pki
./easyrsa gen-req client-john nopass
```

**產出**：
- `pki/private/client-john.key`
- `pki/reqs/client-john.req`

### 3. 簽發 Client 憑證
```bash
./easyrsa sign-req client client-john
```

**產出**：
- `pki/issued/client-john.crt`

### 4. 建立 `.ovpn` 設定檔

```bash
cat > /tmp/client-john.ovpn <<'EOF'
client
dev tun
proto udp
remote vpn.company.com 1194
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
cipher AES-256-CBC
auth SHA256
key-direction 1
verb 3

<ca>
$(cat /etc/openvpn/pki/ca.crt)
</ca>

<cert>
$(cat /etc/openvpn/pki/issued/client-john.crt)
</cert>

<key>
$(cat /etc/openvpn/pki/private/client-john.key)
</key>

<tls-auth>
$(cat /etc/openvpn/ta.key)
</tls-auth>
EOF
```

### 5. 交付給 Client
```bash
# 從容器複製到主機
docker cp openvpn-server:/tmp/client-john.ovpn ./client-john.ovpn
```

> **安全交付**：使用 SCP / 加密郵件，**勿明文傳送**

---

## 四、憑證到期日檢查

### 1. 單一憑證檢查
```bash
# Client 憑證
openssl x509 -in /etc/openvpn/pki/issued/client-john.crt -noout -enddate

# Server 憑證
openssl x509 -in /etc/openvpn/pki/issued/server-prod.crt -noout -enddate
```

**範例輸出**：
```
notAfter=Oct 28 12:34:56 2028 GMT
```

---

### 2. 自動檢查所有憑證（推薦腳本）

```bash
sudo tee /usr/local/bin/check_openvpn_certs.sh > /dev/null <<'EOF'
#!/bin/bash
echo "=== OpenVPN 憑證到期日檢查 ($(date '+%Y-%m-%d %H:%M:%S')) ==="

PKI_DIR="/etc/openvpn/pki"
[ ! -d "$PKI_DIR/issued" ] && echo "錯誤：$PKI_DIR/issued 不存在" && exit 1

for crt in "$PKI_DIR"/issued/*.crt; do
    [ ! -f "$crt" ] && continue
    name=$(basename "$crt")
    enddate=$(openssl x509 -in "$crt" -noout -enddate 2>/dev/null | cut -d= -f2)
    days_left=$(( ($(date -d "$enddate" +%s) - $(date +%s)) / 86400 ))
    
    if [ $days_left -lt 0 ]; then
        status="已過期"
    elif [ $days_left -lt 30 ]; then
        status="即將過期 ($days_left 天)"
    else
        status="正常 ($days_left 天)"
    fi
    
    echo "$name → $enddate [$status]"
done
EOF
```

```bash
sudo chmod +x /usr/local/bin/check_openvpn_certs.sh
```

### 3. 執行檢查
```bash
# 在容器內
/usr/local/bin/check_openvpn_certs.sh

# 或從主機執行（需 mount 卷）
docker exec openvpn-server /usr/local/bin/check_openvpn_certs.sh
```

---

## 五、自動化輪替與監控（進階）

### 1. Cron 每日檢查
```bash
# 在容器內 crontab
0 2 * * * /usr/local/bin/check_openvpn_certs.sh | mail -s "OpenVPN 憑證報告" admin@company.com
```

### 2. 憑證即將過期自動通知
```bash
# 加入腳本末尾
if [ $days_left -lt 30 ] && [ $days_left -ge 0 ]; then
    echo "警告：$name 將於 $days_left 天後過期！" | mail -s "OpenVPN 憑證即將過期" admin@company.com
fi
```

---

## 六、憑證撤銷（CRL）管理

### 1. 撤銷舊憑證
```bash
cd /etc/openvpn/pki
./easyrsa revoke client-old
./easyrsa gen-crl
```

### 2. 更新 Server CRL
```bash
cp pki/crl.pem /etc/openvpn/crl.pem
```

### 3. Server 配置加入
```conf
crl-verify /etc/openvpn/crl.pem
```

### 4. 重啟服務
```bash
docker restart openvpn-server
```

---

## 七、SE/DevOps 最佳實務建議

| 項目 | 建議 |
|------|------|
| **憑證策略** | Server 3 年、Client 1 年，定期輪替 |
| **金鑰保護** | 使用 `nopass` 方便，但 Client 端需加密儲存 |
| **CRL 同步** | 所有 Server 共用同一 CRL |
| **自動化** | Ansible + EasyRSA 批量生成 Client 憑證 |
| **備份** | 定期備份 `/etc/openvpn/pki/` 至加密儲存 |
| **監控** | 整合 Zabbix / Prometheus 監控憑證到期 |
| **安全** | 啟用 `tls-crypt` 取代 `tls-auth`，防中間人攻擊 |

---

**完成！**  
您已掌握：
- Server / Client 憑證更新  
- `.ovpn` 檔自動生成  
- 到期日檢查與自動警報  
- CRL 撤銷管理  

> **專業提醒**：  
> 生產環境建議使用 **ACME（Let’s Encrypt）** 自動化 Server 憑證，或整合 **Hashicorp Vault** 集中管理金鑰。
