# syntax=docker/dockerfile:1.7

# Fubon Trade API sync worker (Railway cron service).
#
# glibc image on purpose: the official SDK ships linux-x64-gnu / linux-arm64-gnu only
# (no musl build), so the Alpine base used by the web app cannot load it.
FROM node:24-slim

ARG FUBON_SDK_VERSION=2.4.0
ARG FUBON_SDK_ZIP_SHA256=7ddb1cb926642a7bf3f946e8eba89156b05071240e1607d373aa63a1773a7b37
ARG FUBON_SDK_TGZ_SHA256=8cf86d0896e16449419ea5264041c4d81abd514a00be76d68044761a4b99151e

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The SDK comes from the broker's own host and is pinned by sha256. Never from npm: the
# public "fubon-neo" package there is a third-party upload, and this repo is public so the
# binary is not committed either. Bumping the version means new hashes (and a fresh review).
RUN mkdir vendor \
  && curl -fsSL -o /tmp/sdk.zip "https://www.fbs.com.tw/TradeAPI_SDK/fubon_binary/fubon-neo-${FUBON_SDK_VERSION}.nodejs.zip" \
  && echo "${FUBON_SDK_ZIP_SHA256}  /tmp/sdk.zip" | sha256sum -c - \
  && unzip -q /tmp/sdk.zip -d vendor \
  && rm /tmp/sdk.zip \
  && echo "${FUBON_SDK_TGZ_SHA256}  vendor/fubon-neo-${FUBON_SDK_VERSION}.tgz" | sha256sum -c -

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY lib.mjs lib.test.mjs index.mjs ./

# Build gates: syntax, unit tests, and "the native SDK actually loads on this platform".
RUN node --check lib.mjs \
  && node --check index.mjs \
  && node --test \
  && timeout 60 node -e "const { FubonSDK } = require('fubon-neo'); if (typeof FubonSDK !== 'function') throw new Error('FubonSDK missing'); console.log('fubon-neo loaded'); process.exit(0)"

# The SDK is a native binary of unknown habits (log / cache files): let the runtime user write /app.
RUN chown -R node:node /app
USER node

# Hard kill after 180 s: a hung native call must not keep the cron slot occupied.
# fetch_log keeps its "not finished" row, so /health shows the run as failed.
CMD ["timeout", "-s", "KILL", "180", "node", "index.mjs"]
