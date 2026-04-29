#!/bin/bash

# Load configuration
source ./config || { echo "Error: Failed to load config file"; exit 1; }

# Get base directory and image tag
basedir=$(dirname "$(realpath "$0")")
IMAGE_TAG=${1:?Error: IMAGE_TAG is required}

# Define Helm chart and values file paths
chart_file="../helm/${IMAGE_NAME}/Chart.yaml"
values_file="../helm/${IMAGE_NAME}/values.yaml"

# Ensure Helm directory exists
mkdir -p "$(dirname "$chart_file")" || { echo "Error: Failed to create Helm directory"; exit 1; }

# Create Chart.yaml
cat << EOF > "$chart_file"
apiVersion: v2
name: ${IMAGE_NAME}
description: A Helm chart for Kubernetes
type: application
version: 0.1.0
appVersion: "1.16.0"
EOF

# Create values.yaml
cat << EOF > "$values_file"
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
  serviceType: NodePort
  sessionAffinity: None
  replicas: ${REPLICAS}
  debugMode: false
  containerLogPath: /root/log
  logPath: /data/log/${IMAGE_NAME}
  limits:
    cpu: 4
    memory: 4G
  requests:
    cpu: 0.5
    memory: 2M

probes:
  liveness:
    scope: [dev1]
    type: l7
    url: ${URL}
    port: 9000
    failureThreshold: 3
    initialDelaySeconds: 60
    periodSeconds: 60
    timeoutSeconds: 10
  readiness:
    scope: [dev1]
    type: l7
    url: ${URL}
    port: 9000
    failureThreshold: 3
    initialDelaySeconds: 60
    periodSeconds: 60
    timeoutSeconds: 10
  startup:
    scope: [dev1]
    type: l7
    url: ${URL1}
    port: 80
    failureThreshold: 5
    initialDelaySeconds: 120
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

# Verify file creation
[[ -f "$chart_file" && -f "$values_file" ]] || { echo "Error: Failed to create Helm files"; exit 1; }
echo "Helm files created successfully: $chart_file, $values_file"