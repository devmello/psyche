# syntax=docker/dockerfile:1.7
# Psyche Gateway image (feature A11; security §10 "Docker defaults"). Owner: S22.
#
#   docker build -f deploy/Dockerfile -t psyche-gateway .        # from the repo root
#
# No bundler: packages resolve files next to their sources (db and notifications migrations,
# memory templates, the sandbox image dir), so the image keeps the workspace layout and runs the
# TypeScript sources with Node 24's built-in type stripping, exactly like `node
# apps/gateway/src/main.ts` in a checkout. Workspace packages live outside node_modules (pnpm
# links them), which is what lets Node strip their types.
#
# Stage `web` builds the web UI with dev dependencies, on the build platform (its dist is plain
# JS and CSS). Stage `deps` installs production dependencies of the Gateway and the CLI only, built
# for the target platform (natives such as better-sqlite3 and sqlite-vec). Both fetch packages from
# the lockfile alone before copying the sources, so a new commit with the same lockfile reuses the
# download layer from the build cache. The runtime is Node 24 slim, uid 10001, files root-owned and
# read-only, $PSYCHE_HOME on a volume, and a healthcheck on the bare /healthz.
#
# The Gateway binds 127.0.0.1 and refuses anything else, so the sample Compose file runs it with
# host networking: it listens on the host's loopback, and the proxy (Tailscale Serve, cloudflared)
# reaches it there. No port is published.

ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG NODE_BUILD_IMAGE=node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a

FROM ${NODE_BUILD_IMAGE} AS base
ENV CI=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
WORKDIR /src
RUN corepack enable

# Not `FROM base`: --platform does not apply to a stage reference.
FROM --platform=$BUILDPLATFORM ${NODE_BUILD_IMAGE} AS web
ENV CI=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
WORKDIR /src
RUN corepack enable
# package.json pins pnpm for corepack; the lockfile alone decides what is fetched.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@psyche/web..."
# Served by the Gateway at /; an empty dir if the web build is unavailable (404 at /).
RUN pnpm --filter @psyche/web build || mkdir -p apps/web/dist

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --prod
COPY . .
RUN pnpm install --offline --frozen-lockfile --prod --filter "@psyche/gateway..." --filter "@psyche/cli..." \
 && rm -rf apps/desktop apps/mac-helper apps/web/src docs tests apps/site \
      .changeset .github /root/.cache /root/.local/share/pnpm

FROM ${NODE_IMAGE} AS runtime
ARG PSYCHE_VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="psyche-gateway" \
      org.opencontainers.image.description="Psyche Gateway (psyched) and CLI" \
      org.opencontainers.image.source="https://github.com/devmello/psyche" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${PSYCHE_VERSION}"
# No PSYCHE_HOST / PSYCHE_PORT: they would override config.json (the Gateway's defaults are
# 127.0.0.1:7979). The healthcheck reads PSYCHE_PORT only if you set it yourself.
ENV NODE_ENV=production \
    PSYCHE_HOME=/data \
    DO_NOT_TRACK=1
RUN groupadd --system --gid 10001 psyche \
 && useradd --system --uid 10001 --gid psyche --home-dir /home/psyche --create-home --shell /usr/sbin/nologin psyche \
 && mkdir -p /data && chown psyche:psyche /data && chmod 0700 /data
COPY --from=deps --chown=root:root /src /app
COPY --from=web --chown=root:root /src/apps/web/dist /app/apps/web/dist
RUN printf '#!/bin/sh\nexec node /app/apps/gateway/src/main.ts "$@"\n' > /usr/local/bin/psyched \
 && printf '#!/bin/sh\nexec node /app/apps/cli/src/main.ts "$@"\n' > /usr/local/bin/psyche \
 && chmod 0755 /usr/local/bin/psyched /usr/local/bin/psyche
USER 10001:10001
WORKDIR /data
VOLUME ["/data"]
# Bare, unauthenticated health check (security §10).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PSYCHE_PORT||7979)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["psyched"]
