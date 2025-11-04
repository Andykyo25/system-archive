# 單機 Kubernetes 環境建置完整教學（kubeadm + 完整生態）

**適用情境**：  
僅一台 VM/實體機，需快速建立 **完整可用 Kubernetes 環境**，包含：
- **CNI（Flannel）**
- **Ingress（NGINX）**
- **Storage（Local Path）**
- **Metrics Server**
- **Helm**
- **cert-manager（自動憑證）**

> **系統需求**：Ubuntu 20.04+ / 22.04、**2 CPU / 4GB RAM 以上**

---

## 一、系統調整（Swap、netfilter）

> **為何關閉 swap？**  
> K8s 不支援 swap，會干擾 **cgroup 記憶體管控**，導致 Pod OOM 行為不一致。

```bash
# 關閉 swap（永久）
sudo swapoff -a
sudo sed -i '/ swap / s/^/#/' /etc/fstab

# 啟用必要 kernel 模組
cat <<'EOF' | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF

sudo modprobe overlay
sudo modprobe br_netfilter

# 設定 sysctl（封包過濾 + IP 轉發）
cat <<'EOF' | sudo tee /etc/sysctl.d/99-k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF

sudo sysctl --system
```

---

## 二、安裝 Containerd（systemd cgroup）

> **為何用 containerd？**  
> K8s **不直接啟動容器**，由 **containerd** 負責映像拉取、容器生命週期。  
> **systemd cgroup** 與 kubelet 一致，避免資源度量錯亂。

```bash
sudo apt-get update
sudo apt-get install -y containerd

# 建立預設配置
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml > /dev/null

# 啟用 systemd cgroup
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml

# 啟動服務
sudo systemctl enable --now containerd
```

---

## 三、安裝 kubeadm / kubelet / kubectl

> **kubeadm**：叢集初始化工具  
> **kubelet**：Node 代理，啟動/監控 Pod  
> **kubectl**：管理指令列工具

```bash
sudo apt-get update
sudo apt-get install -y apt-transport-https ca-certificates curl

# 匯入官方金鑰與套件庫（v1.30）
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.30/deb/Release.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg

echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /' \
  | sudo tee /etc/apt/sources.list.d/kubernetes.list

# 安裝並鎖定版本
sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl
```

---

## 四、初始化控制平面（Control Plane）

> **Control Plane** = 叢集大腦（API Server、etcd、scheduler、controller-manager）

```bash
sudo kubeadm init \
  --pod-network-cidr=10.244.0.0/16 \
  --kubernetes-version v1.30.0
```

**成功輸出**：
```
Your Kubernetes control-plane has initialized successfully!
```

### 設定 kubectl 憑證
```bash
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

---

## 五、安裝 CNI（Flannel）

> **為何需要 CNI？**  
> 沒有網路插件，Pod 卡在 `ContainerCreating`，無法通訊。

```bash
kubectl apply -f https://raw.githubusercontent.com/flannel-io/flannel/refs/heads/master/Documentation/kube-flannel.yml
```

---

## 六、允許控制平面排程（單機必做）

```bash
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
```

---

## 七、安裝 Ingress（NGINX）與 Storage

### 1. NGINX Ingress Controller
```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.1/deploy/static/provider/baremetal/deploy.yaml
```

> **驗證**：
> ```bash
> kubectl get pods -n ingress-nginx
> ```

### 2. Local Path Provisioner（本地儲存）
```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/master/deploy/local-path-storage.yaml

# 設為預設 StorageClass
kubectl patch storageclass local-path \
  -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

---

## 八、安裝 Metrics Server（HPA 基礎）

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

> 啟用後可使用 `kubectl top nodes/pods`

---

## 九、安裝 Helm

```bash
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version
```

---

## 十、安裝 cert-manager（自動憑證）

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm upgrade --install cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace \
  --set crds.enabled=true
```

> 後續可搭配 Let's Encrypt 自動簽發 HTTPS 憑證

---

## 十一、設定 kubectl 別名（提升效率）

```bash
cat <<'EOF' >> ~/.bashrc
alias k=kubectl
complete -o default -F __start_kubectl k
EOF
source ~/.bashrc
```

---

## 驗證完整環境

| 指令 | 預期結果 |
|------|---------|
| `k get nodes` | `Ready` |
| `k get pods -A` | 所有核心元件 `Running` |
| `k top nodes` | 顯示 CPU/MEM 使用 |
| `k get ingressclass` | `nginx` 存在 |
| `k get sc` | `local-path` 為 `(default)` |

---

## K8s 核心觀念補充

| 觀念 | 說明 |
|------|------|
| **宣告式管理** | 只要定義 `replicas: 3`，K8s 自動維持 3 個 Pod |
| **層級結構** | `Cluster > Namespace > Node > Pod > Container` |
| **Deployment** | 無狀態服務首選，支援滾動更新 |
| **StatefulSet** | 有狀態服務（如 DB），固定 Pod 名稱與儲存 |
| **控制迴圈** | 所有控制器持續比對 **期望 vs 實際** 狀態 |
| **YAML = 叢集設計圖** | 所有資源皆由 YAML 定義 |
| **Namespace** | 資源隔離（dev/staging/prod） |
| **Rolling Update** | 預設更新策略，需搭配 **Readiness/Liveness Probe** |

---

## SE/DevOps 最佳實務建議

| 項目 | 建議 |
|------|------|
| **映像安全** | 使用 `docker.elastic.co` 官方映像，避免自製 |
| **版本鎖定** | `kubeadm init --kubernetes-version v1.30.0` |
| **備份 etcd** | `kubeadm` 定期快照 |
| **監控** | 後續安裝 **Prometheus + Grafana** |
| **日誌** | 部署 **Filebeat DaemonSet** |
| **CI/CD** | 搭配 **ArgoCD** 或 **Flux** |

---

**完成！**  
您已成功建置 **單機完整 Kubernetes 環境**，具備：
- 控制平面 + 工作節點
- 網路、儲存、Ingress
- Helm + cert-manager
- 高效 `kubectl` 操作

> **專業提醒**：  
> 生產環境建議 **至少 3 個 Master**（etcd 高可用），並使用 **外部 Load Balancer** 分發 API Server 流量。
