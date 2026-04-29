#!/usr/bin/env bash
# =============================================================================
#  極致優化版 - 與 dev 版完全一致（2025 Andy 工程標準）
# =============================================================================

set -euo pipefail                      # 嚴格模式
IFS=$'\n\t'                            # 防止字串分割問題

# ------------------ 顏色定義 ------------------
RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' NC='\033[0m'
log()   { echo -e "${GREEN}[$(date +'%H:%M:%S')] INFO  $*${NC}"; }
warn()  { echo -e "${YELLOW}[$(date +'%H:%M:%S')] WARN  $*${NC}"; }
error() { echo -e "${RED}[$(date +'%H:%M:%S')] ERROR $*${NC}"; exit 1; }

# ------------------ 路徑與環境載入 ------------------
basedir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "${basedir}/config" ]] || error "找不到 config 檔案：${basedir}/config"
source "${basedir}/config"

# ------------------ 參數處理 ------------------
MOD="${1:-}"                           # 環境模組：sit-eks / uat-eks / demo-eks
IMAGE_TAG="${2:-latest}"               # 預設 latest

[[ -n "${MOD}" ]] || error "用法: $0 <sit-eks|uat-eks|demo-eks> [image-tag]"
[[ -n "${IMAGE_NAME:-}" ]] || error "IMAGE_NAME 未定義，請檢查 config"
[[ -n "${REGISTRY:-}" ]]   || error "REGISTRY 未定義，請檢查 config"
[[ -n "${REPLICAS:-}" ]]   || error "REPLICAS 未定義，請檢查 config"

# ------------------ 依 MOD 切換環境變數 ------------------
case "${MOD}" in
  "sit-eks")
    APOLLO_CLUSTER="${SIT_APOLLO_CLUSTER:-}"
    KAFKA_TOPIC="${SIT_KAFKA_TOPIC:-}"
    SERVER_PORT="${SIT_SERVER_PORT:-}"
    SERVICE_NAME="${SIT_SERVICE_NAME:-}"
    ;;
  "uat-eks")
    APOLLO_CLUSTER="${UAT_APOLLO_CLUSTER:-}"
    KAFKA_TOPIC="${UAT_KAFKA_TOPIC:-}"
    SERVER_PORT="${UAT_SERVER_PORT:-}"
    SERVICE_NAME="${UAT_SERVICE_NAME:-}"
    ;;
  "demo-eks")
    APOLLO_CLUSTER="${DEMO_APOLLO_CLUSTER:-}"
    KAFKA_TOPIC="${DEMO_KAFKA_TOPIC:-}"
    SERVER_PORT="${DEMO_SERVER_PORT:-}"
    SERVICE_NAME="${DEMO_SERVICE_NAME:-}"
    ;;
  *)
    error "不支援的環境模組: ${MOD}，僅支援 sit-eks / uat-eks / demo-eks"
    ;;
esac

# 必要環境變數防呆
[[ -n "${SERVICE_NAME:-}" ]] || error "${MOD} 的 SERVICE_NAME 未定義"
[[ -n "${SERVER_PORT:-}" ]]  || error "${MOD} 的 SERVER_PORT 未定義"

# ------------------ 自動建立目錄 ------------------
helm_dir="${basedir}/../helm/${IMAGE_NAME}"
mkdir -p "${helm_dir}"

log "開始產生 Helm Chart：${IMAGE_NAME} (環境: ${MOD}, Tag: ${IMAGE_TAG})"

# ------------------ Chart.yaml ------------------
cat > "${helm_dir}/Chart.yaml" << EOF
apiVersion: v2
name: ${IMAGE_NAME}
description: A Helm chart for Kubernetes
type: application
version: 0.1.0
appVersion: '1.16.0'
EOF

# ------------------ values.yaml（與 dev 版一致 + readiness 優化） ------------------
cat > "${helm_dir}/values.yaml" << EOF
app:
  name: ${SERVICE_NAME}
  projectName: ${IMAGE_NAME}
  ports:
    - name: port8080
      port: 8080
      containerPort: 8080
      protocol: TCP
      nodePort: ${SERVER_PORT}
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
    memory: 1Gi
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
    initDelaySeconds: 30
    periodSeconds: 10
    timeoutSeconds: 5
  startup:
    scope:
      - dev1
    type: l7
    url: ${URL1:-/}
    port: 80
    failureThreshold: 10
    initDelaySeconds: 120
    periodSeconds: 120
    timeoutSeconds: 10
  env:
    ENV_METHOD: ${ENV_METHOD:-}
    APOLLO_URL: ${APOLLO_URL:-}
    APOLLO_ENV: ${APOLLO_ENV:-}
    APOLLO_APPID: ${APOLLO_APPID:-}
    APOLLO_CLUSTER: ${APOLLO_CLUSTER:-}
    APOLLO_SECRET: ${APOLLO_SECRET:-}
    APOLLO_NAMESPACE: ${APOLLO_NAMESPACE:-}
    APOLLO_NAMESPACE_INFRA: ${APOLLO_NAMESPACE_INFRA:-}
    KAFKA_NODE: ${KAFKA_NODE:-}
    KAFKA_TOPIC: ${KAFKA_TOPIC:-}
EOF

# ------------------ 完成提示 ------------------
log "Helm Chart 產生成功！"
echo -e "   ${GREEN}服務名稱：${IMAGE_NAME}${NC}"
echo -e "   ${GREEN}環境模組：${MOD}${NC}"
echo -e "   ${GREEN}映像路徑：${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}${NC}"
echo -e "   ${GREEN}輸出目錄：${helm_dir}${NC}"
echo -e "   ${GREEN}NodePort：${SERVER_PORT}${NC}"
echo -e "   ${GREEN}副本數：${REPLICAS}${NC}"
echo ""