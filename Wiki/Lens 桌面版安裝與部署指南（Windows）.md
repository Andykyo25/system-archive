# **Lens 桌面版安裝與部署指南（Windows）**  
**目標**：在 Windows 11/10 上使用 **Lens** 圖形化管理 **AWS EKS 叢集**，無需手打 `kubectl` 指令。

> **SE/DevOps 專業提醒**：  
> Lens 只是 **GUI 外殼**，底層仍依賴 `kubectl` + `aws cli`。  
> 所有操作最終由 **kubeconfig** 驅動，務必正確設定 IAM 與 Access Entry。

---

## 必備軟體清單

| 軟體 | 用途 | 下載與安裝方式 |
|------|------|----------------|
| **AWS CLI v2** | `aws eks update-kubeconfig` | [官方 MSI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |
| **kubectl** | 底層 K8s 操作 | [官方下載](https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/) |
| **Lens 桌面版** | GUI 管理 EKS | [官方網站](https://k8slens.dev/) |

---

## 一、安裝與設定必備軟體

### 1. 安裝 **AWS CLI v2**

1. 下載 MSI 安裝包  
   → https://awscli.amazonaws.com/AWSCLIV2.msi
2. 雙擊安裝（預設路徑：`C:\Program Files\Amazon\AWSCLIV2\`）
3. **驗證安裝**
   ```powershell
   aws --version
   ```
   預期輸出：
   ```
   aws-cli/2.17.0 Python/3.11.8 Windows/10 exe/AMD64 prompt/off
   ```

---

### 2. 安裝 **kubectl**

1. 下載對應 EKS 版本的 `kubectl.exe`  
   → https://docs.aws.amazon.com/eks/latest/userguide/install-kubectl.html
2. 建立目錄並移動：
   ```powershell
   mkdir "C:\Program Files\kubectl"
   Move-Item .\kubectl.exe "C:\Program Files\kubectl\"
   ```
3. **加入 PATH**
   - 搜尋「進階系統設定」→ 環境變數  
   - 系統變數 → `Path` → 新增：`C:\Program Files\kubectl\`
4. **驗證**
   ```powershell
   kubectl version --client
   ```

---

### 3. 安裝 **Lens**

1. 下載安裝包：https://k8slens.dev/
2. 雙擊安裝（預設路徑：`C:\Program Files\Lens\`）
3. 開啟 Lens → 確認無錯誤

---

## 二、AWS IAM 與 EKS 權限設定（必做！）

### 1. 建立或使用 IAM User / Role
- 建議使用 **IAM User**（開發）或 **IAM Role + SSO**（生產）

### 2. 建立 Access Key
```text
AWS Console → IAM → Users → [你的帳號] → Security credentials → Create access key
```
記下：
- `Access Key ID`
- `Secret Access Key`（只顯示一次！）

### 3. 加入 EKS Access Entry（關鍵！）

```bash
# 將你的 IAM User/Role 加入 EKS 存取
aws eks create-access-entry \
  --cluster-name <your-cluster-name> \
  --principal-arn arn:aws:iam::123456789012:user/your-iam-user \
  --type STANDARD
```

### 4. 綁定 EKS 管理權限
```bash
aws eks associate-access-policy \
  --cluster-name <your-cluster-name> \
  --principal-arn arn:aws:iam::123456789012:user/your-iam-user \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster
```

> 權限選項：
> - `AmazonEKSClusterAdminPolicy`：完全管理
> - `AmazonEKSAdminPolicy`：管理員
> - `AmazonEKSDeveloperPolicy`：開發者

---

## 三、設定 AWS CLI 與 kubeconfig

### 1. 設定 AWS CLI 認證
```powershell
aws configure
```
輸入：
```
AWS Access Key ID:     AKIA...
AWS Secret Access Key: xxxxx
Default region name:   ap-northeast-1
Default output format: json
```

---

### 2. 產生 EKS kubeconfig

```powershell
aws eks update-kubeconfig \
  --region ap-northeast-1 \
  --name veri-id-mix-prod \
  --alias veri-id-mix
```

**建議**：產生獨立 config 檔，避免污染預設
```powershell
aws eks update-kubeconfig \
  --region ap-northeast-1 \
  --name veri-id-mix-prod \
  --kubeconfig C:\Users\%USERNAME%\.kube\veri-id-mix.kubeconfig
```

---

### 3. **修正 kubeconfig 中的 `aws` 路徑（Windows 必做！）**

編輯 `C:\Users\%USERNAME%\.kube\config` 或獨立檔：

```yaml
- name: arn:aws:eks:ap-northeast-1:123456789012:cluster/veri-id-mix-prod
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: C:\Program Files\Amazon\AWSCLIV2\aws.exe   # ← 改成絕對路徑
      args:
        - eks
        - get-token
        - --cluster-name
        - veri-id-mix-prod
        - --region
        - ap-northeast-1
```

---

### 4. 驗證 kubeconfig 可用

```powershell
kubectl --kubeconfig C:\Users\%USERNAME%\.kube\veri-id-mix.kubeconfig get nodes
```

預期輸出：
```
NAME                                          STATUS   ROLES    AGE   VERSION
ip-10-0-1-100.ap-northeast-1.compute.internal Ready    <none>   5d    v1.30.0-eks
```

---

## 四、將 EKS 叢集加入 Lens

### 步驟 1：開啟 Lens
- 啟動 **Lens**

### 步驟 2：新增叢集
1. 左側選單 → **Clusters** → **+ Add Cluster**
2. 選擇 **Custom kubeconfig**
3. 點擊 **Browse** → 選取：
   ```
   C:\Users\%USERNAME%\.kube\veri-id-mix.kubeconfig
   ```
4. 選擇正確的 **context**（如 `veri-id-mix`）
5. 點擊 **Add Cluster**

---

## 五、Lens 常用功能速覽

| 功能 | 操作方式 |
|------|----------|
| 查看 Pod | `Workloads → Pods` |
| 即時 Log | 點擊 Pod → `Logs` |
| 執行 Shell | 點擊 Pod → `Exec` |
| 查看 Events | `Cluster → Events` |
| 編輯 YAML | 點擊資源 → `Edit` |
| 多叢集切換 | 左上角下拉選單 |

---

## 常見問題除錯

| 問題 | 解決方式 |
|------|----------|
| `Unable to connect to the server` | 檢查 `aws configure` 與 `kubeconfig` 路徑 |
| `command not found: aws` | `kubeconfig` 中 `command` 改為絕對路徑 |
| `access denied` | 確認 IAM 已加入 **EKS Access Entry** |
| Lens 顯示空白 | 重啟 Lens 或清除快取：`%APPDATA%\Lens` |

---

## SE/DevOps 最佳實務建議

| 項目 | 建議 |
|------|------|
| **kubeconfig 安全** | 不要 commit 到 Git，使用 `.gitignore` |
| **多叢集管理** | 為每個環境建立獨立 config 檔 |
| **權限最小化** | 開發用 `AmazonEKSDeveloperPolicy` |
| **自動化** | 寫 `.bat` 腳本自動更新 kubeconfig |
| **備份** | 定期備份 `~/.kube/` 目錄 |

---

**完成！**  
您已成功在 Windows 上部署 **Lens + EKS 整合環境**，可：
- 圖形化管理多個 EKS 叢集  
- 即時查看 Log / Shell / Events  
- 安全使用 IAM 認證  

> **專業提醒**：  
> 生產環境建議搭配 **AWS SSO + Lens OpenID Connect**，避免長期 Access Key。  
> Lens 企業版支援 **RBAC 視圖限制**，適合團隊協作。
