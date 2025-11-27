#!/bin/bash

# 1. 取得腳本所在目錄的絕對路徑
BASE_DIR=$(cd "$(dirname "$0")" && pwd)

# 2. 載入 Config
if [ -f "${BASE_DIR}/config" ]; then
    source "${BASE_DIR}/config"
else
    echo "Error: config file not found at ${BASE_DIR}/config"
    exit 1
fi

# 參數接收
NAME_SPACE="$1"
IMAGE_TAG="$2"

# 3. 檢查必要參數
if [[ -z "$NAME_SPACE" || -z "$IMAGE_TAG" ]]; then
    echo "Usage: $0 <NAME_SPACE> <IMAGE_TAG>"
    exit 1
fi

# 錯誤檢查函數
Check_Error () {
    local ret_code=$1
    local action=$2
    local target=$3
    
    if [ "${ret_code}" -eq 0 ]; then
        echo "${action} ${target} success"
    else
        echo "${action} ${target} fail"
        exit 1
    fi
}

# 4. 主要邏輯
case "$NAME_SPACE" in
    "sit-eks"|"uat-eks"|"sit-k8s"|"dev-k8s")
        # 執行外部配置腳本
        if [ -f "${BASE_DIR}/../spring/set_helm.sh" ]; then
            bash "${BASE_DIR}/../spring/set_helm.sh" "$IMAGE_TAG"
        else
             echo "Error: set_helm.sh not found"
             exit 1
        fi

        # 進入 helm 目錄
        cd "${BASE_DIR}/../helm" || exit 1

        echo "Deploying ${IMAGE_NAME_1} to ${NAME_SPACE}..."

        # 5. 核心優化：合併 Install 與 Upgrade
        helm upgrade --install "$IMAGE_NAME_1" "./$IMAGE_NAME_1" \
            --namespace "$NAME_SPACE" \
            --create-namespace
        
        # 檢查執行結果
        Check_Error $? "k8s deployment" "$NAME_SPACE"
        ;;
    *)
        echo "Error: Undefined namespace '$NAME_SPACE'"
        exit 1
        ;;
esac