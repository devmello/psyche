# Psyche spike-02 sandbox image: nonroot (UID 1000), meant to run with a read-only rootfs.
FROM node:24-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash python3 git jq ripgrep ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspace /run/psyche && chown 1000:1000 /workspace /run/psyche \
 # Apple container has no no-new-privileges flag, so remove setuid/setgid binaries instead.
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + 
# In-sandbox half of the socket egress bridge (spikes/sandbox-backends/egress/socket-bridge.py).
COPY egress/socket-bridge.py /usr/local/lib/psyche/socket-bridge.py
# The node image already ships user "node" with UID/GID 1000.
USER 1000:1000
WORKDIR /workspace
ENV HOME=/workspace PATH=/usr/local/bin:/usr/bin:/bin
CMD ["sleep", "infinity"]
