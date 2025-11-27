#!/bin/bash

# 1. 取得腳本所在目錄的絕對路徑，確保執行路徑正確
BASE_DIR=$(cd "$(dirname "$0")" && pwd)

# 2. 載入 Config (使用絕對路徑)
if [ -f "${BASE_DIR}/config" ]; then
    source "${BASE_DIR}/config"
else
    echo "Error: config file not found at ${BASE_DIR}/config"
    exit 1
fi

# Java 環境設定
JAVA_HOME="/usr/lib/jvm/java-21-openjdk-amd64/"
if [ -d "$JAVA_HOME" ]; then
    PATH="$JAVA_HOME/bin:$PATH"
else
    echo "Warning: JAVA_HOME not found at $JAVA_HOME"
fi

# 參數接收
ENV="$1"
IMAGE_VERSION="$2"

# 3. 檢查參數是否為空 (優化安全性)
if [[ -z "$ENV" || -z "$IMAGE_VERSION" ]]; then
    echo "Usage: $0 <ENV> <IMAGE_VERSION>"
    exit 1
fi

# 4. 優化錯誤檢查函數：明確傳入 exit code ($1=return_code, $2=name, $3=env)
Check_Error () {
    local ret_code=$1
    local name=$2
    local env=$3
    
    if [ "${ret_code}" -eq 0 ]; then
        echo "${name} ${env} success"
    else
        echo "${name} ${env} fail"
        exit 1
    fi
}

# 5. 環境變數檢查 (使用 Bash 內建 [[ ]] 語法更安全)
if ! [[ "$ENV" == "sit" || "$ENV" == "uat" || "$ENV" == "prd" || "$ENV" == "dev" ]]; then
    echo "Undefined ENV : $ENV"
    exit 1
fi

# 6. 切換目錄 (使用基於腳本的相對路徑，而非執行者的相對路徑)
cd "${BASE_DIR}/.." || exit 1

# 寫入版本資訊
echo "app.version=${IMAGE_VERSION}" > "${IMAGE_NAME_1}/src/main/resources/version.properties"

# 進入專案目錄
cd "${IMAGE_NAME_1}" || exit 1

# Maven Build
"${MVN_PATH}" clean install -Dmaven.test.skip

# Docker Build
docker build -t "${REGISTRY_BUILD}/${IMAGE_NAME_1}:${IMAGE_VERSION}" --build-arg REGISTRY="${REGISTRY_BASE}" .
# 捕捉執行結果並傳給檢查函數
Check_Error $? "${IMAGE_NAME_1}" "${ENV}"

echo "${REGISTRY_BUILD}/${IMAGE_NAME_1}:${IMAGE_VERSION}"

# Docker Push
docker push "${REGISTRY_BUILD}/${IMAGE_NAME_1}:${IMAGE_VERSION}"
# 捕捉執行結果並傳給檢查函數
Check_Error $? "${IMAGE_NAME_1}" "${ENV}"

echo "${IMAGE_NAME_1} ${ENV} build success"