# spike-02: sandbox backends (throwaway)

Prototype for `docs/archive/spikes-docs/spike-02-apple-container.md`. Not a package; S21 owns the real
`SandboxRunner` in `packages/sandbox`.

| file | what it does |
|---|---|
| `Dockerfile` | nonroot image (UID 1000, no setuid bits, bash/python/node/git/jq/ripgrep, socket-bridge shim) |
| `build-image.sh <backend>` | builds `psyche-sandbox:spike` |
| `lib.sh` | backend abstraction: hardening flags per backend, volume init, start/exec/stop |
| `contract.sh <backend> [socket]` | per-task contract checks → `results/contract-*.md` |
| `measure.sh <backend> [--cold N]` | cold/warm start, exec round trip, 200 MB file share, memory → `results/measure-*.md` |
| `egress-test.sh <backend> [socket]` | opt-in egress through the allowlisting proxy → `results/egress-*.md` |
| `egress/proxy.py` | host-side HTTP (CONNECT + absolute-form) and SOCKS5 proxy with a domain allowlist |
| `egress/relay.py` | TCP relay sidecar for Docker `--internal` networks |
| `egress/socket-bridge.py` | reverse-pool bridge over Apple `--publish-socket` (keeps `--network none`) |

Backends: `apple` (Apple `container`), `docker` (current Docker context; OrbStack here),
`colima` (Docker against the `colima` context, not run in this spike).

```bash
./build-image.sh apple && ./contract.sh apple && ./measure.sh apple --cold 3
./egress-test.sh apple socket
```

`--cold` stops and restarts the backend (every container on it). Scripts target macOS
`/bin/bash` 3.2. Scratch files go to `.work/` (ignored).
