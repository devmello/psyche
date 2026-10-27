# syntax=docker/dockerfile:1.7
# TEMPORARY INT-2 image for compose.yaml: the workspace with dev tooling, running psyched from
# source through tsx. S22's deploy/Dockerfile (PR #60) replaces it with a bundled, slim,
# non-root image once merged.
FROM node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a
ENV CI=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
ENV NODE_ENV=production \
    PSYCHE_HOME=/data
USER node
VOLUME ["/data"]
ENTRYPOINT ["node", "--import", "tsx", "apps/gateway/src/main.ts"]
