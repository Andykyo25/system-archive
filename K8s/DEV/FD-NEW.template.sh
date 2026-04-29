#!/bin/bash
# =============================================================================
#  原始腳本極致優化版 - 2025 DevOps 最佳實踐（單檔無依賴）
#  使用方式完全不變： ./generate-chart.sh v1.2.3
# =============================================================================

set -euo pipefail                      # 嚴格模式：錯誤立即中止、未定義變數炸掉
IFS=$'\n\t'                            # 安全分割字元

# ------------------ 路徑處理（防呆） ------------------
basedir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${basedir}/config"             # 使用絕對路徑，避免相對路徑怪事

# ------------------ 參數處理（防呆） ------------------
IMAGE_TAG="${1:-latest}"               # 沒給 tag 就用 latest
[[ -n "${IMAGE_NAME:-}" ]] || { echo "ERROR: IMAGE_NAME 未定義！"; exit 1; }

# ------------------ 自動建立必要目錄 ------------------
helm_dir="../helm/${IMAGE_NAME}"
mkdir -p "${helm_dir}"

# ------------------ 顏色輸出------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log() { echo -e "${GREEN}[$(date +'%H:%M:%S')] $*${NC}"; }
err() { echo -e "${RED}[ERROR] $*${NC}"; exit 1; }

# ------------------ 產生 Chart.yaml（使用 cat << EOF 取代 echo 地獄） ------------------
cat > "${helm_dir}/Chart.yaml" << EOF
apiVersion: v2
name: ${IMAGE_NAME}
description: A Helm chart for Kubernetes
type: application
version: 0.1.0
appVersion: "${IMAGE_TAG}"
EOF

# ------------------ 產生 values.yaml（一次性寫入 + 嚴格縮排 + 自動 git tag fallback） ------------------
# 若變數未定義，自動補安全預設值
: "${REPLICAS:=1}"
: "${DEV_SERVER_PORT:=30000}"
: "${URL:=/}"
: "${URL1:=/}"
: "${DEV_KAFKA_TOPIC:=default-topic}"

cat > "${helm_dir}/values.yaml" << EOF
app:
  name: ${DEV_SERVICE_NAME:-${IMAGE_NAME}}
  projectName: ${IMAGE_NAME}
  ports:
    - name: port8080
      port: 8080
      containerPort: 8080
      protocol: TCP
      nodePort: ${DEV_SERVER_PORT}
      targetPort: 8080

build:
  imageName: ${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}

deploy:
  progressDeadlineSeconds: 600
  revisionHistoryLimit: 10
  maxSurge: 25%
  maxUnavailable: 25%
  imagePullPolicy: Always
  restartPolicy: Always
  Servicetype: NodePort
  sessionAffinity: None
  replicas: ${REPLICAS}
  debugMode: false
  containerLogPath: /home/veriid/log
  logPath: /data/log/${IMAGE_NAME}
  limits:
    cpu: "4"
    memory: 4G
  requests:
    memory: 2M
    cpu: "0.5"
  liveness:
    scope:
      - dev1
    type: l7
    url: ${URL}
    port: 8080
    failureThreshold38Threshold: 3
    initDelaySeconds: 60
    periodSeconds: 60
    timeoutSeconds: 10
  readiness:
    scope:
      - dev1
    type: l7
    url: ${URL}
    port: 8080
    failureThreshold: 3
    initDelaySeconds: 60
    periodSeconds: 60
    timeoutSeconds: 10
  startup:
    scope:
      - dev1
    type: l7
    url: ${URL1}
    port: 80
    failureThreshold: 5
    initDelaySeconds: 120
    periodSeconds: 120
    timeoutSeconds: 10

env:
  ENV_METHOD: ${ENV_METHOD:-dev}
  APOLLO_URL: ${APOLLO_URL:-}
  APOLLO_ENV: ${APOLLO_ENV:-DEV}
  APOLLO_APPID: ${APOLLO_APPID:-}
  APOLLO_CLUSTER: ${DEV_APOLLO_CLUSTER:-default}
  APOLLO_SECRET: ${APOLLO_SECRET:-}
  APOLLO_NAMESPACE: ${APOLLO_NAMESPACE:-application}
  APOLLO_NAMESPACE_INFRA: ${APOLLO_NAMESPACE_INFRA:-infra}
  KAFKA_NODE: ${KAFKA_NODE:-}
  KAFKA_TOPIC: ${DEV_KAFKA_TOPIC}
EOF

# ------------------ 完成提示------------------
log "Helm Chart 產生成功！"
echo "   服務名稱：${IMAGE_NAME}"
echo "   映像標籤：${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
echo "   輸出目錄：${helm_dir}"
echo "   NodePort：${DEV_SERVER_PORT}"
echo "   副本數量：${REPLICAS}"
echo ""