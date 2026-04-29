#!/bin/bash
source ./config
basedir=$(cd $(dirname $0); pwd)
MOD=$1
IMAGE_TAG=$2

# IMAGE_NAME
env_file=../helm/${IMAGE_NAME}/Chart.yaml

echo "
apiVersion: v2
name: ${IMAGE_NAME}
description: A Helm chart for Kubernetes

type: application

version: 0.1.0

appVersion: '1.16.0'
" > ${env_file}

Check_Error () {
    if [ $? -eq 0 ]; then
        echo "$1 $2 success"
    else
        echo "$1 $2 fail"
        exit 1
    fi
}

if [ $MOD == "sit-eks" ]; then
    APOLLO_CLUSTER=${SIT_APOLLO_CLUSTER}
    KAFKA_TOPIC=${SIT_KAFKA_TOPIC}
    SERVER_PORT=${SIT_SERVER_PORT}
    SERVICE_NAME=${SIT_SERVICE_NAME} 

elif [ $MOD == "uat-eks" ]; then
    APOLLO_CLUSTER=${UAT_APOLLO_CLUSTER}
    KAFKA_TOPIC=${UAT_KAFKA_TOPIC}
    SERVER_PORT=${UAT_SERVER_PORT}
    SERVICE_NAME=${UAT_SERVICE_NAME} 

elif [ $MOD == "demo-eks" ]; then
    APOLLO_CLUSTER=${DEMO_APOLLO_CLUSTER}
    KAFKA_TOPIC=${DEMO_KAFKA_TOPIC}
    SERVER_PORT=${DEMO_SERVER_PORT}
    SERVICE_NAME=${DEMO_SERVICE_NAME} 
else
    echo "no $MOD tag"
    exit 1
fi

env_file=../helm/${IMAGE_NAME}/values.yaml

echo "
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
  # aliases:
  #   - ip:
  #     hosts:
  #       -
  debugMode: false
  containerLogPath: /home/veriid/log
  # configmapRequired:
  # configmapByEnvRequired:
  # configmaps:
  #   - key:
  #     mountPath:
  #     path:
  logPath: /data/log/${IMAGE_NAME}
  limits:
    cpu: 4
    memory: 4G
  requests:
    memory: 2M
    cpu: 0.5
  liveness:
    scope:
      - dev1
    type: l7
    url: ${URL}
    port: 8080
    failureThreshold: 3
    initDelaySeconds: 70
    periodSeconds: 70
    timeoutSeconds: 10
  readiness:
    scope:
      - dev1
    type: l7
    url: ${URL}
    port: 8080
    failureThreshold: 3
    initDelaySeconds: 70
    periodSeconds: 70
    timeoutSeconds: 10
  env:
    ENV_METHOD: ${ENV_METHOD}
    APOLLO_URL: ${APOLLO_URL}
    APOLLO_ENV: ${APOLLO_ENV}
    APOLLO_APPID: ${APOLLO_APPID}
    APOLLO_CLUSTER: ${APOLLO_CLUSTER}
    APOLLO_SECRET: ${APOLLO_SECRET}
    APOLLO_NAMESPACE: ${APOLLO_NAMESPACE}
    APOLLO_NAMESPACE_INFRA: ${APOLLO_NAMESPACE_INFRA}
    KAFKA_NODE: ${KAFKA_NODE}
    KAFKA_TOPIC: ${KAFKA_TOPIC}
" > ${env_file}
