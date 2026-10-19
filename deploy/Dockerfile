# syntax=docker/dockerfile:1.7
# Psyche Gateway image (feature A11; security §10 "Docker defaults"). Owner: S22.
#
#   docker build -f deploy/Dockerfile -t psyche-gateway .        # from the repo root
#
# Stage 1 installs the workspace and bundles psyched and the psyche CLI with esbuild (one ESM file
# each; native modules stay external). Stage 2 is Node 24 slim, uid 10001, no shell tools beyond
# the base image, $PSYCHE_HOME on a volume, and a healthcheck on the bare /healthz.
#
# The Gateway binds 127.0.0.1 and refuses anything else, so the sample Compose file runs it with
# host networking: it listens on the host's loopback, and the proxy (Tailscale Serve, cloudflared)
# reaches it there. No port is published.

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG NODE_BUILD_IMAGE=node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0

FROM ${NODE_BUILD_IMAGE} AS build
ENV CI=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
WORKDIR /src
RUN corepack enable
COPY . .
# Only what the image needs: the Gateway, the CLI and the web UI (no Electron, no desktop).
RUN pnpm install --frozen-lockfile \
      --filter "@psyche/gateway..." --filter "@psyche/cli..." --filter "@psyche/web..."
# Web UI served by the Gateway at / (skipped quietly if the web build is not available).
RUN pnpm --filter @psyche/web build || echo "web UI not built; the Gateway answers 404 at /"
ARG ESBUILD_VERSION=0.28.2
ARG PSYCHE_VERSION=0.0.0-dev
RUN set -eux; \
    mkdir -p /tmp/esbuild /out/app/web; \
    npm install --prefix /tmp/esbuild --no-audit --no-fund "esbuild@${ESBUILD_VERSION}"; \
    cp deploy/scripts/bundle.mjs /tmp/esbuild/; \
    node /tmp/esbuild/bundle.mjs /src /out/app "${PSYCHE_VERSION}"; \
    # @psyche/db resolves migrations as new URL("../migrations/", import.meta.url): bin/../migrations.
    cp -r packages/db/migrations /out/app/migrations; \
    if [ -d apps/web/dist ]; then cp -r apps/web/dist/. /out/app/web/; fi; \
    # Native modules at the exact versions the workspace resolved, built for this platform.
    sqlite="$(cd packages/db && node -p "require('better-sqlite3/package.json').version")"; \
    printf '{"name":"psyche-gateway-runtime","private":true,"type":"module","dependencies":{"better-sqlite3":"%s"}}\n' "$sqlite" > /out/app/package.json; \
    cd /out/app && npm install --omit=dev --no-audit --no-fund; \
    rm -rf /root/.npm /tmp/esbuild
# Wrappers on PATH.
RUN printf '#!/bin/sh\nexec node /app/bin/psyched.mjs "$@"\n' > /out/psyched \
 && printf '#!/bin/sh\nexec node /app/bin/psyche.mjs "$@"\n' > /out/psyche \
 && chmod 0755 /out/psyched /out/psyche

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
    PSYCHE_WEB_ROOT=/app/web \
    DO_NOT_TRACK=1
RUN groupadd --system --gid 10001 psyche \
 && useradd --system --uid 10001 --gid psyche --home-dir /home/psyche --create-home --shell /usr/sbin/nologin psyche \
 && mkdir -p /data && chown psyche:psyche /data && chmod 0700 /data
COPY --from=build --chown=root:root /out/app /app
COPY --from=build /out/psyched /out/psyche /usr/local/bin/
USER 10001:10001
WORKDIR /data
VOLUME ["/data"]
# Bare, unauthenticated health check (security §10).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PSYCHE_PORT||7979)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["psyched"]
