#!/bin/bash
# 1. 嚴格模式
set -euo pipefail

# --- 全域變數與顏色設定 ---
readonly BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly HELM_BASE_DIR="$(dirname "$BASE_DIR")/helm"
readonly GREEN='\033[0;32m'
readonly RED='\033[0;31m'
readonly NC='\033[0m'

# --- 輔助函式 ---
log_info() { echo -e "${GREEN}[INFO]  $1${NC}"; }
log_error() { echo -e "${RED}[ERROR] $1${NC}" >&2; }

# 錯誤捕捉
trap 'log_error "Error occurred on line $LINENO"' ERR

# --- 1. 載入設定 ---
if [[ -f "$BASE_DIR/config" ]]; then
    source "$BASE_DIR/config"
else
    log_error "Config file not found: $BASE_DIR/config"
    exit 1
fi

IMAGE_TAG="${1:-}"

if [[ -z "$IMAGE_TAG" ]]; then
    log_error "Usage: $0 <IMAGE_TAG>"
    exit 1
fi

# 檢查必要變數
if [[ -z "${IMAGE_NAME_1:-}" || -z "${SERVICE_NAME_1:-}" ]]; then
    log_error "Missing required variables in config (IMAGE_NAME_1 or SERVICE_NAME_1)"
    exit 1
fi

# --- 2. 準備目錄 ---
TARGET_DIR="$HELM_BASE_DIR/${IMAGE_NAME_1}"
log_info "Target Helm Directory: $TARGET_DIR"

if [[ ! -d "$TARGET_DIR" ]]; then
    log_info "Directory not found, creating: $TARGET_DIR"
    mkdir -p "$TARGET_DIR"
fi

# --- 3. 產生 Chart.yaml ---
CHART_FILE="$TARGET_DIR/Chart.yaml"
log_info "Generating $CHART_FILE"

cat > "$CHART_FILE" <<EOF
apiVersion: v2
name: ${SERVICE_NAME_1}
description: A Helm chart for Kubernetes
type: application
version: 0.1.0
appVersion: '1.16.0'
EOF

# --- 4. 產生 values.yaml ---
VALUES_FILE="$TARGET_DIR/values.yaml"
log_info "Generating $VALUES_FILE (Tag: $IMAGE_TAG)"

# 使用 cat <<EOF 可以讓 YAML 結構一目了然，不需要用 echo 逐行拼接
cat > "$VALUES_FILE" <<EOF
app:
  name: "${SERVICE_NAME_1}"
  projectName: "${SERVICE_NAME_1}"
  ports:
    - name: port8080
      port: 8080
      containerPort: 8080
      protocol: TCP
      nodePort: ${SERVER_PORT_1}
      targetPort: 8080

build:
  imageName: "${REGISTRY}/${IMAGE_NAME_1}:${IMAGE_TAG}"

deploy:
  progressDeadlineSeconds: 600
  revisionHistoryLimit: 10
  maxSurge: 25%
  maxUnavailable: 25%
  imagePullPolicy: Always
  restartPolicy: Always
  Servicetype: NodePort
  sessionAffinity: None
  replicas: ${REPLICAS_1}
  debugMode: false
  containerLogPath: /root/log
  logPath: "/data/log/${IMAGE_NAME_1}"
  
  # 資源限制
  limits:
    memory: 3Gi
  requests:
    memory: 1Gi

  # 健康檢查
  liveness:
    scope:
      - dev1
    type: l7
    url: "${URL_1}"
    port: 8080
    failureThreshold: 3
    initDelaySeconds: 60
    periodSeconds: 60
    timeoutSeconds: 10
  
  readiness:
    scope:
      - dev1
    type: l7
    url: "${URL_1}"
    port: 8080
    failureThreshold: 3
    initDelaySeconds: 60
    periodSeconds: 60
    timeoutSeconds: 10

  # 環境變數
  env:
    ENV_METHOD: "${ENV_METHOD}"
    APOLLO_URL: "${APOLLO_URL}"
    APOLLO_ENV: "${APOLLO_ENV}"
    APOLLO_APPID: "${APOLLO_APPID}"
    APOLLO_CLUSTER: "${APOLLO_CLUSTER}"
    APOLLO_SECRET: "${APOLLO_SECRET}"
    APOLLO_NAMESPACE: "${APOLLO_NAMESPACE_1}"
    KAFKA_NODE: "${KAFKA_NODE}"
    KAFKA_TOPIC: "${KAFKA_TOPIC_1}"
    OPENTELEMETRY_SERVICE_NAME: "${OPENTELEMETRY_SERVICE_NAME}"
    OPENTELEMETRY_TRACES_EXPORTER: "${OPENTELEMETRY_TRACES_EXPORTER}"
    OPENTELEMETRY_METRICS_EXPORTER: "${OPENTELEMETRY_METRICS_EXPORTER}"
    OPENTELEMETRY_OTLP_ENDPOINT: "${OPENTELEMETRY_OTLP_ENDPOINT}"
    OPENTELEMETRY_OTLP_PROTOCOL: "${OPENTELEMETRY_OTLP_PROTOCOL}"
EOF

log_info "Helm Chart generation completed successfully!"