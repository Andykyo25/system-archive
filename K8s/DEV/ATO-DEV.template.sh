#!/bin/bash
source ./config
basedir=$(cd $(dirname $0); pwd)
IMAGE_TAG=$1

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


env_file=../helm/${IMAGE_NAME}/values.yaml

echo "
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
    ENV_METHOD: ${ENV_METHOD}
    APOLLO_URL: ${APOLLO_URL}
    APOLLO_ENV: ${APOLLO_ENV}
    APOLLO_APPID: ${APOLLO_APPID}
    APOLLO_CLUSTER: ${DEV_APOLLO_CLUSTER}
    APOLLO_SECRET: ${APOLLO_SECRET}
    APOLLO_NAMESPACE: ${APOLLO_NAMESPACE}
    APOLLO_NAMESPACE_INFRA: ${APOLLO_NAMESPACE_INFRA}
    KAFKA_NODE: ${KAFKA_NODE}
    KAFKA_TOPIC: ${DEV_KAFKA_TOPIC}
" > ${env_file}
