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

ARG NODE_IMAGE=node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
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

# desktop: a graphical Linux desktop for the "separate desktop" computer-use mode
# (docs/design/linux-desktop-2026.md section 8). full (which already holds LibreOffice's layers)
# + Xvfb, a private D-Bus session bus, the AT-SPI bus, Firefox ESR, a small file manager, and the
# Linux helper (the one binary the Gateway pairs as kind "guest"). It keeps every sandbox rule:
# UID/GID 1000 psyche, read-only rootfs (only /tmp and /workspace are written), no setuid/setgid
# (harden.sh), no network unless the owner allows it for a Task (then only through the egress
# proxy). The helper binary is not built here: stage it at desktop/psyche-helper before building
# (see README.md); HELPER_SHA256, when given, must match it.
FROM full AS desktop
# The helper is the one program that holds the Gateway's trust inside the container, so its
# checksum is required: a build without HELPER_SHA256 fails. A local dev build may skip the check
# with --build-arg ALLOW_UNVERIFIED_HELPER=1; release and CI builds (publish.sh) never do.
ARG HELPER_SHA256=
ARG ALLOW_UNVERIFIED_HELPER=
USER 0:0
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      adwaita-icon-theme at-spi2-core dbus dbus-daemon firefox-esr fonts-liberation \
      libreoffice-calc libreoffice-gtk3 libreoffice-impress libreoffice-writer \
      pcmanfm tini xvfb \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /shares && chmod 0755 /shares
COPY --chown=0:0 --chmod=0755 desktop/psyche-helper /usr/local/bin/psyche-helper
COPY --chown=0:0 --chmod=0755 desktop/entrypoint.sh /usr/local/lib/psyche/desktop-entrypoint.sh
COPY --chown=0:0 --chmod=0644 desktop/firefox-policies.json /etc/firefox/policies/policies.json
RUN if [ -n "$HELPER_SHA256" ]; then \
      echo "$HELPER_SHA256  /usr/local/bin/psyche-helper" | sha256sum -c - ; \
    elif [ "$ALLOW_UNVERIFIED_HELPER" = "1" ]; then \
      echo "WARNING: the helper binary was not verified (ALLOW_UNVERIFIED_HELPER=1)" >&2 ; \
    else \
      echo "HELPER_SHA256 is required (or ALLOW_UNVERIFIED_HELPER=1 for a local dev build)" >&2 ; \
      exit 1 ; \
    fi \
 && sh /usr/local/lib/psyche/harden.sh
ENV XDG_RUNTIME_DIR=/tmp/run \
    DISPLAY=:1 \
    GNOME_ACCESSIBILITY=1 \
    MOZ_ENABLE_WAYLAND=0 \
    PSYCHE_NODE_SOCKET=/run/psyche/node.sock \
    PSYCHE_HOME=/tmp/psyche \
    PSYCHE_HELPER_STATE=/tmp/psyche-helper \
    PSYCHE_HELPER_SURFACE=separate_desktop
LABEL dev.psyche.sandbox.desktop="1"
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/lib/psyche/desktop-entrypoint.sh"]
