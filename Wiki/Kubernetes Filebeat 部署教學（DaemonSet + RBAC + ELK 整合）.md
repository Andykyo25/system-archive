# Kubernetes Filebeat 部署教學（DaemonSet + RBAC + ELK 整合）

**適用情境**：  
在 **Kubernetes 叢集**中集中收集 **所有容器日誌（stdout/stderr）與系統日誌**，傳送至 **ELK 叢集**（Elasticsearch + Kibana）進行集中管理、搜尋與視覺化。  
本教學使用 **兩份 YAML**（`filebeat-k8s.yaml` + `filebeat-rbac.yaml`）完成 **Filebeat DaemonSet** 部署，無需 Helm，維護成本低。

> **SE/DevOps 最佳實務**：  
> - 使用 **DaemonSet** 確保每台 Node 都有 Filebeat  
> - 搭配 **RBAC** 自動附加 Pod metadata（Namespace、Pod 名稱、Label）  
> - 支援 **多 ES 節點高可用**、**Kibana Dashboard 自動匯入**

---

## 環境準備

| 項目 | 需求 |
|------|------|
| **Kubernetes** | v1.21+（已安裝 `kubectl`） |
| **ELK 叢集** | Elasticsearch（多節點）、Kibana 可達 |
| **ES 帳號密碼** | `elastic` / `your_strong_password` |
| **Node 權限** | 確保 `/var/log` 與 `/var/lib/docker/containers` 可讀（預設可） |

---

## 第一步：`filebeat-k8s.yaml`（DaemonSet + ConfigMap + ServiceAccount）

```yaml
# filebeat-k8s.yaml
---
# 1. ServiceAccount
apiVersion: v1
kind: ServiceAccount
metadata:
  name: filebeat
  namespace: kube-system
---
# 2. ConfigMap - Filebeat 設定檔
apiVersion: v1
kind: ConfigMap
metadata:
  name: filebeat-config
  namespace: kube-system
data:
  filebeat.yml: |
    filebeat.inputs:
      - type: container
        paths:
          - /var/lib/docker/containers/*/*.log
        symlinks: true
        ignore_older: 30m
        json.keys_under_root: true
        json.add_error_key: true

    processors:
      - add_kubernetes_metadata:
          host: ${NODE_NAME}
          matchers:
            - logs_path:
                logs_path: "/var/lib/docker/containers/"

      - add_docker_metadata: {}

    output.elasticsearch:
      hosts: 
        - "http://192.168.10.201:9200"
        - "http://192.168.10.205:9200"
        - "http://192.168.10.207:9200"
      username: "elastic"
      password: "YourStrongElasticPwd123!"
      index: "k8s-logs-%{[agent.version]}-%{+yyyy.MM.dd}"

    setup.kibana:
      host: "http://192.168.10.209:5601"

    setup.template.name: "k8s-logs"
    setup.template.pattern: "k8s-logs-*"
---
# 3. DaemonSet - 在每個 Node 運行 Filebeat
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: filebeat
  namespace: kube-system
  labels:
    app: filebeat
spec:
  selector:
    matchLabels:
      app: filebeat
  template:
    metadata:
      labels:
        app: filebeat
    spec:
      serviceAccountName: filebeat
      terminationGracePeriodSeconds: 30
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      containers:
        - name: filebeat
          image: docker.elastic.co/beats/filebeat:7.17.13
          args: [
            "-c", "/usr/share/filebeat/filebeat.yml",
            "-e",
            "-strict.perms=false"
          ]
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: ELASTICSEARCH_HOSTS
              value: "http://192.168.10.201:9200,http://192.168.10.205:9200,http://192.168.10.207:9200"
          securityContext:
            runAsUser: 0
          resources:
            limits:
              memory: 300Mi
            requests:
              cpu: 100m
              memory: 100Mi
          volumeMounts:
            - name: config
              mountPath: /usr/share/filebeat/filebeat.yml
              subPath: filebeat.yml
            - name: varlog
              mountPath: /var/log
              readOnly: true
            - name: dockercontainers
              mountPath: /var/lib/docker/containers
              readOnly: true
      volumes:
        - name: config
          configMap:
            name: filebeat-config
        - name: varlog
          hostPath:
            path: /var/log
        - name: dockercontainers
          hostPath:
            path: /var/lib/docker/containers
```

---

## 第二步：`filebeat-rbac.yaml`（RBAC 權限）

```yaml
# filebeat-rbac.yaml
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: filebeat
rules:
  - apiGroups: [""]
    resources:
      - nodes
      - namespaces
      - pods
      - events
    verbs: ["get", "list", "watch"]
  - apiGroups: ["coordination.k8s.io"]
    resources:
      - leases
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: [""]
    resources:
      - configmaps
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: filebeat
subjects:
  - kind: ServiceAccount
    name: filebeat
    namespace: kube-system
roleRef:
  kind: ClusterRole
  name: filebeat
  apiGroup: rbac.authorization.k8s.io
```

---

## 第三步：部署與驗證

### 1. 部署順序（**先 RBAC → 再 DaemonSet**）

```bash
# 必須先有權限
kubectl apply -f filebeat-rbac.yaml

# 再啟動 Filebeat
kubectl apply -f filebeat-k8s.yaml
```

### 2. 驗證 Pod 狀態

```bash
kubectl get pods -n kube-system -l app=filebeat
```

**預期輸出**：
```
NAME             READY   STATUS    RESTARTS   AGE
filebeat-abcde   1/1     Running   0          2m
filebeat-fghij   1/1     Running   0          2m
```

### 3. 查看 Filebeat 日誌

```bash
kubectl logs -n kube-system daemonset/filebeat --tail=20
```

**關鍵訊息**：
```
Connected to Elasticsearch
Index setup complete
Harvester started for file: /var/lib/docker/containers/xxx/xxx-json.log
```

---

## 第四步：Kibana 驗證日誌

1. 開啟 Kibana：`http://192.168.10.209:5601`
2. 登入：`elastic` / `YourStrongElasticPwd123!`
3. **Management → Stack Management → Index Patterns**
4. 建立 Index Pattern：`k8s-logs-*`
5. 選擇 `@timestamp` 為時間欄位
6. **Discover** → 搜尋 `kubernetes.pod_name:*` 應看到日誌

---

## 第五步：匯入 Filebeat Dashboard（選用）

```bash
# 在任意 Node 執行（需 kubectl + curl）
kubectl exec -n kube-system daemonset/filebeat -- filebeat setup --dashboards
```

> 自動匯入 **Filebeat System**, **Kubernetes** 等預設 Dashboard

---

## 進階設定建議

| 功能 | 設定方式 |
|------|---------|
| **多 ES 高可用** | `hosts: ["http://es1:9200", "http://es2:9200"]` |
| **TLS/SSL** | 加入 `ssl.certificate_authorities` 與 `ssl.verification_mode: full` |
| **過濾系統日誌** | 加入 `exclude_lines: ['^DBG', 'healthcheck']` |
| **自訂 Index** | `index: "k8s-${NODE_NAME}-%{+yyyy.MM.dd}"` |
| **資源限制** | 調整 `resources.limits.memory` 依 Node 負載 |
| **Sidecar 模式** | 改用 `Deployment` + `hostPath` 收集特定應用 |

---

## SE/DevOps 最佳實務

| 項目 | 建議 |
|------|------|
| **命名空間** | 部署於 `kube-system`，避免干擾業務 |
| **版本管理** | 使用 `image: filebeat:7.17.13` 固定版本 |
| **日誌輪替** | ES 端使用 ILM 策略（30 天保留） |
| **監控** | 匯入 Filebeat 自監控 Dashboard |
| **備份** | 定期 Snapshot ES 索引 |
| **升級** | 滾動更新 DaemonSet：`kubectl rollout restart daemonset filebeat -n kube-system` |

---

**完成！**  
您已成功在 Kubernetes 中部署 **Filebeat DaemonSet**，實現：
- 自動收集所有容器日誌  
- 附加完整 Kubernetes metadata  
- 安全傳送至 ELK 叢集  
- Kibana 可視化與搜尋  

> **專業提醒**：  
> 生產環境建議搭配 **EFK（Fluentd）** 或 **Loki + Grafana** 作為備援，實現多日誌後端策略。
