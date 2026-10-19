# syntax=docker/dockerfile:1
# Psyche sandbox image (owner S21; contract: docs/05-security-and-permissions.md §5.1).
#
# Targets, each built on the previous one:
#   core  bash, Python 3 + uv, Node 24, git, ripgrep, jq, curl   (CI and unit smoke tests)
#   base  core + pandoc, poppler-utils, pdftk-java, ffmpeg        (the default runtime image)
#   full  base + LibreOffice (writer, calc, impress; no GUI)      (optional larger image)
#
# Every target runs as UID/GID 1000, works with a read-only root filesystem (only /tmp and
# /workspace are written), has no setuid/setgid binaries (Apple `container` has no
# no-new-privileges flag) and gives root no login shell. Base images are pinned by digest;
# keep them in sync with versions.json (scripts in this directory read it).

ARG NODE_IMAGE=node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336

FROM ${UV_IMAGE} AS uv

FROM ${NODE_IMAGE} AS core
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl findutils git jq procps python3 ripgrep util-linux \
 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
COPY harden.sh /usr/local/lib/psyche/harden.sh
# The node image ships user "node" with UID/GID 1000; rename it and give it /workspace.
RUN groupmod -n psyche node \
 && usermod -l psyche -d /workspace -s /bin/bash node \
 && mkdir -p /workspace \
 && chown 1000:1000 /workspace \
 && chmod 0755 /workspace \
 && sh /usr/local/lib/psyche/harden.sh
ENV HOME=/workspace \
    TMPDIR=/tmp \
    LANG=C.UTF-8 \
    PATH=/workspace/.local/bin:/usr/local/bin:/usr/bin:/bin \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_CACHE_DIR=/workspace/.cache/uv \
    UV_LINK_MODE=copy \
    npm_config_cache=/workspace/.cache/npm \
    npm_config_update_notifier=false \
    HISTFILE=/tmp/.bash_history
LABEL org.opencontainers.image.title="psyche-sandbox" \
      org.opencontainers.image.source="https://github.com/devmello/psyche" \
      org.opencontainers.image.licenses="Apache-2.0" \
      dev.psyche.sandbox.contract="1"
USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]

FROM core AS base
USER 0:0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg pandoc pdftk-java poppler-utils \
 && rm -rf /var/lib/apt/lists/* \
 && sh /usr/local/lib/psyche/harden.sh
USER 1000:1000

FROM base AS full
USER 0:0
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fonts-dejavu-core libreoffice-calc-nogui libreoffice-impress-nogui libreoffice-writer-nogui \
 && rm -rf /var/lib/apt/lists/* \
 && sh /usr/local/lib/psyche/harden.sh
USER 1000:1000
