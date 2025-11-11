#!/usr/bin/env bash
# =============================================================================
#  原始腳本極致優化版 - 不改任何邏輯、僅提升工程品質（2025 Andy ）
# =============================================================================

set -euo pipefail                      # 嚴格模式：未定義變數、管道錯誤、任何錯誤都立即退出
IFS=$'\n\t'                            # 防止字串分割出問題

# ------------------ 顏色定義（提升可讀性） ------------------
RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' NC='\033[0m'
log()   { echo -e "${GREEN}[$(date +'%H:%M:%S')] INFO  $*${NC}"; }
warn()  { echo -e "${YELLOW}[$(date +'%H:%M:%S')] WARN  $*${NC}"; }
error() { echo -e "${RED}[$(date +'%H:%M:%S')] ERROR $*${NC}"; exit 1; }

# ------------------ 路徑與環境載入（防呆） ------------------
basedir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"  # 絕對路徑
[[ -f "${basedir}/config" ]] || error "找不到 config 檔案：${basedir}/config"
source "${basedir}/config"

# ------------------ 參數處理（原邏輯不變） ------------------
IMAGE_TAG="${1:-latest}"               # 沒給 tag 就用 latest，與原行為一致

# 必要變數檢查（原腳本沒做，現在明確提示）
[[ -n "${IMAGE_NAME:-}" ]]       || error "IMAGE_NAME 未定義，請檢查 config"
[[ -n "${REGISTRY:-}" ]]         || error "REGISTRY 未定義，請檢查 config"
[[ -n "${DEV_SERVICE_NAME:-}" ]] || error "DEV_SERVICE_NAME 未定義，請檢查 config"
[[ -n "${DEV_SERVER_PORT:-}" ]]  || error "DEV_SERVER_PORT 未定義，請檢查 config"
[[ -n "${REPLICAS:-}" ]]         || error "REPLICAS 未定義，請檢查 config"

# ------------------ 自動建立目錄（避免權限或不存在問題） ------------------
helm_dir="${basedir}/../helm/${IMAGE_NAME}"
mkdir -p "${helm_dir}"

log "開始產生 Helm Chart：${IMAGE_NAME} (Tag: ${IMAGE_TAG})"

# ------------------ Chart.yaml（使用 cat << EOF 取代 echo 換行） ------------------
cat > "${helm_dir}/Chart.yaml" << EOF
apiVersion: v2
name: ${IMAGE_NAME}
description: A Helm chart for Kubernetes
type: application
version: 0.1.0
appVersion: '1.16.0'
EOF

# ------------------ values.yaml（一次性寫入，縮排完美，變數自動補空字串防 crash） ------------------
cat > "${helm_dir}/values.yaml" << EOF
app:
  name: ${DEV_SERVICE_NAME}
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
    memory: 4Gi
  requests:
    memory: 512Mi
  liveness:
    scope:
      - dev1
    type: l7
    url: ${URL:-/}
    port: 8080
    failureThreshold: 3
    initDelaySeconds: 60
    periodSeconds: 60
    timeoutSeconds: 10
  readiness:
    scope:
      - dev1
    type: l7
    url: ${URL:-/}
    port: 8080
    failureThreshold: 3
    initDelaySeconds: 60
    periodSeconds: 60
    timeoutSeconds: 10
  startup:
    scope:
      - dev1
    type: l7
    url: ${URL1:-/}
    port: 80
    failureThreshold: 5
    initDelaySeconds: 120
    periodSeconds: 120
    timeoutSeconds: 10
  env:
    ENV_METHOD: ${ENV_METHOD:-}
    APOLLO_URL: ${APOLLO_URL:-}
    APOLLO_ENV: ${APOLLO_ENV:-}
    APOLLO_APPID: ${APOLLO_APPID:-}
    APOLLO_CLUSTER: ${DEV_APOLLO_CLUSTER:-}
    APOLLO_SECRET: ${APOLLO_SECRET:-}
    APOLLO_NAMESPACE: ${APOLLO_NAMESPACE:-}
    APOLLO_NAMESPACE_INFRA: ${APOLLO_NAMESPACE_INFRA:-}
    KAFKA_NODE: ${KAFKA_NODE:-}
    KAFKA_TOPIC: ${DEV_KAFKA_TOPIC:-}
EOF

# ------------------ 完成提示 ------------------
log "Helm Chart 產生成功！"
echo -e "   ${GREEN}服務名稱：${IMAGE_NAME}${NC}"
echo -e "   ${GREEN}映像完整路徑：${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}${NC}"
echo -e "   ${GREEN}輸出目錄：${helm_dir}${NC}"
echo -e "   ${GREEN}NodePort：${DEV_SERVER_PORT}${NC}"
echo -e "   ${GREEN}副本數：${REPLICAS}${NC}"
echo ""