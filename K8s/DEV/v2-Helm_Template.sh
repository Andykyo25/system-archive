#!/bin/bash

source ./config
basedir=$(cd $(dirname $0); pwd)
IMAGE_TAG=$1

# 參數檢查
if [[ -z "$IMAGE_TAG" ]]; then
    echo "用法: $0 <IMAGE_TAG>"
    exit 1
fi

# 創建目錄
mkdir -p ../helm/${IMAGE_NAME}

# Chart.yaml
env_file=../helm/${IMAGE_NAME}/Chart.yaml
cat > ${env_file} << EOF
apiVersion: v2
name: ${IMAGE_NAME}
description: A Helm chart for ${IMAGE_NAME}
type: application
version: 0.1.0
appVersion: '${IMAGE_TAG}'
EOF

# values.yaml
env_file=../helm/${IMAGE_NAME}/values.yaml
cat > ${env_file} << EOF
app:
  name: ${DEV_SERVICE_NAME}
  projectName: ${IMAGE_NAME}
  ports:
    - name: port80
      port: 80
      containerPort: 80
      protocol: TCP
      nodePort: ${DEV_JWT_PORT}
      targetPort: 80
    - name: port9000
      port: 9000
      containerPort: 9000
      protocol: TCP
      nodePort: ${DEV_AA_PORT}
      targetPort: 9000

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
  containerLogPath: /root/log
  logPath: /data/log/${IMAGE_NAME}
  
  limits:
    cpu: "4"
    memory: "4Gi"
  requests:
    memory: "512Mi"
    cpu: "500m"
    
  liveness:
    scope:
      - dev1
    type: l7
    url: ${URL}
    port: 9000
    failureThreshold: 3
    initDelaySeconds: 60
    periodSeconds: 60
    timeoutSeconds: 10
    
  readiness:
    scope:
      - dev1
    type: l7
    url: ${URL}
    port: 9000
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
    ENV_METHOD: ${ENV_METHOD}
    APOLLO_URL: ${APOLLO_URL}
    APOLLO_ENV: ${APOLLO_ENV}
    APOLLO_APPID: ${APOLLO_APPID}
    APOLLO_CLUSTER: ${DEV_APOLLO_CLUSTER}
    APOLLO_SECRET: ${APOLLO_SECRET}
    APOLLO_NAMESPACE: ${APOLLO_NAMESPACE}
    KAFKA_NODE: ${KAFKA_NODE}
    KAFKA_TOPIC: ${DEV_KAFKA_TOPIC}
    DB_NAME: ${DEV_DB_NAME}
    DB_HOST: ${DB_HOST}
EOF

echo "✅ Helm Chart 生成完成: ../helm/${IMAGE_NAME}"
echo "端口映射: HTTP=${DEV_JWT_PORT}->80, 管理=${DEV_AA_PORT}->9000"