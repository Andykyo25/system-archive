#!/bin/bash
# 1. 嚴格模式：任何錯誤中止，變數未定義報錯
set -euo pipefail

# --- 全域變數與顏色設定 ---
readonly BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly GREEN='\033[0;32m'
readonly RED='\033[0;31m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m'

# --- 輔助函式 ---
log_info() { echo -e "${GREEN}[INFO] $1${NC}"; }
log_warn() { echo -e "${YELLOW}[WARN] $1${NC}"; }
log_error() { echo -e "${RED}[ERROR] $1${NC}" >&2; }

# 錯誤捕捉
trap 'log_error "Script failed on line $LINENO"' ERR

# --- 前置檢查 ---

# 1. 載入設定
if [[ -f "$BASE_DIR/config" ]]; then
    source "$BASE_DIR/config"
else
    log_error "Config file not found at $BASE_DIR/config"
    exit 1
fi

NAME_SPACE="${1:-}"
IMAGE_TAG="${2:-}"

# 2. 參數檢查
if [[ -z "$NAME_SPACE" || -z "$IMAGE_TAG" ]]; then
    echo "Usage: $0 <NAMESPACE> <IMAGE_TAG>"
    exit 1
fi

# 3. 環境白名單檢查
case "$NAME_SPACE" in
    sit-eks|uat-eks|sit-k8s|dev-k8s)
        log_info "Target Namespace: $NAME_SPACE"
        ;;
    *)
        log_error "Unknown namespace: $NAME_SPACE"
        exit 1
        ;;
esac

# --- 定義檢查清單 ---
# 如果有多個服務，可以在這裡繼續添加
SERVICES=("${SERVICE_NAME_1}")
HEALTH_URLS=("${VERSION_CHECK_1}")

# 預期的版本字串格式 (保持原邏輯)
EXPECTED_VERSION="\"version\":\"${IMAGE_TAG}\""

log_info "Start Deployment Verification..."
log_info "Expected Version String: $EXPECTED_VERSION"

# --- 迴圈檢查邏輯 ---

# 取得陣列長度
count=${#SERVICES[@]}

for (( i=0; i<count; i++ )); do
    SERVICE="${SERVICES[$i]}"
    URL="${HEALTH_URLS[$i]}"

    log_info "---------------------------------------------------"
    log_info "Checking Service [$((i+1))/$count]: $SERVICE"
    log_info "Health URL: $URL"

    # 1. 檢查 K8s Rollout 狀態
    log_info "Waiting for rollout status..."
    if ! kubectl rollout status "deployment/$SERVICE" -n "$NAME_SPACE" --timeout=300s; then
        log_error "❌ Kubernetes deployment rollout failed for $SERVICE"
        exit 1
    fi

    log_info "Rollout complete. Starting HTTP version check..."
    
    # 2. HTTP 版本檢查 (加入 Retry 機制)
    # 網路路由生效可能需要時間，嘗試 5 次，每次間隔 5 秒
    MAX_RETRIES=5
    RETRY_COUNT=0
    CHECK_PASSED=false

    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        sleep 5

        # 執行 Curl (加入 -L 以跟隨轉址)
        RESPONSE=$(curl --max-time 10 -s -L "$URL" || true)

        if echo "$RESPONSE" | grep -q "$EXPECTED_VERSION"; then
            CHECK_PASSED=true
            break
        else
            ((RETRY_COUNT++))
            log_warn "Attempt $RETRY_COUNT/$MAX_RETRIES: Version mismatch or connection failed."
            if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
                log_warn "Last Response: $RESPONSE"
            fi
        fi
    done

    if [ "$CHECK_PASSED" = true ]; then
        log_info "✅ Version check passed for $SERVICE!"
    else
        log_error "❌ Version check failed for $SERVICE after $MAX_RETRIES attempts."
        log_error "   Expected: $EXPECTED_VERSION"
        exit 1
    fi
done

log_info "---------------------------------------------------"
log_info "🎉 All checks passed! Deployment Verified."
exit 0