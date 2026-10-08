# syntax=docker/dockerfile:1.7

# Fubon Trade API sync worker (Railway cron service).
#
# glibc image on purpose: the official SDK ships linux-x64-gnu / linux-arm64-gnu only
# (no musl build), so the Alpine base used by the web app cannot load it.
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The SDK comes from the broker's own host and is pinned by sha256. Never from npm: the
# public "fubon-neo" package there is a third-party upload, and this repo is public so the
# binary is not committed either. Bumping the version means new hashes (and a fresh review).
#
# The pins are plain shell variables inside this RUN, deliberately NOT ARG: Railway hands its
# service variables to the build as ARGs, so an ARG-based pin can be overridden from outside
# (a build once failed against a hash that was not in the repo). The computed hash is printed
# so a real mismatch is diagnosable from the build log.
RUN set -eu \
  && V=2.4.0 \
  && ZIP_SHA256=7ddb1cb926642a7bf3f946e8eba89156b05071240e1607d373aa63a1773a7b37 \
  && TGZ_SHA256=8cf86d0896e16449419ea5264041c4d81abd514a00be76d68044761a4b99151e \
  && mkdir vendor \
  && curl -fsSL -o /tmp/sdk.zip "https://www.fbs.com.tw/TradeAPI_SDK/fubon_binary/fubon-neo-${V}.nodejs.zip" \
  && echo "sdk.zip computed=$(sha256sum /tmp/sdk.zip | cut -d' ' -f1) expected=${ZIP_SHA256}" \
  && echo "${ZIP_SHA256}  /tmp/sdk.zip" | sha256sum -c - \
  && unzip -q /tmp/sdk.zip -d vendor \
  && rm /tmp/sdk.zip \
  && echo "sdk.tgz computed=$(sha256sum vendor/fubon-neo-${V}.tgz | cut -d' ' -f1) expected=${TGZ_SHA256}" \
  && echo "${TGZ_SHA256}  vendor/fubon-neo-${V}.tgz" | sha256sum -c -

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY lib.mjs lib.test.mjs jobs-lib.mjs jobs-lib.test.mjs jobs.mjs index.mjs ./

# Build gates: syntax, unit tests, and "the native SDK actually loads on this platform".
RUN node --check lib.mjs \
  && node --check jobs-lib.mjs \
  && node --check jobs.mjs \
  && node --check index.mjs \
  && node --test \
  && timeout 60 node -e "const { FubonSDK } = require('fubon-neo'); if (typeof FubonSDK !== 'function') throw new Error('FubonSDK missing'); console.log('fubon-neo loaded'); process.exit(0)"

# The SDK is a native binary of unknown habits (log / cache files): let the runtime user write /app.
RUN chown -R node:node /app
USER node

# Hard kill (default 600 s; the daily sync takes ~20 s and the background jobs have their own
# 420 s budget, JOB_BUDGET_SEC): a hung native call must not keep the cron slot occupied.
# fetch_log keeps its "not finished" row, so /health shows the run as failed.
CMD ["sh", "-c", "exec timeout -s KILL \"${HARD_KILL_SEC:-600}\" node index.mjs"]
