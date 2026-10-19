# Sandbox image

**Owner:** S21. Used by [`@psyche/sandbox`](../../packages/sandbox/README.md); the contract is in [security §5.1](../../docs/05-security-and-permissions.md) and K8 in the [feature spec](../../docs/03-feature-spec.md).

| target | contents | size (arm64, uncompressed) |
|---|---|---|
| `core` | Debian 13 (node:24 trixie-slim), Node 24, bash, Python 3 + uv, git, ripgrep, jq, curl, procps | 618 MB |
| `base` | core + pandoc, poppler-utils, pdftk-java, ffmpeg (the default runtime image) | 1.76 GB |
| `full` | base + LibreOffice writer, calc and impress (no GUI) | 2.3 GB |

Every target:

- runs as `psyche`, UID/GID 1000, with `HOME=/workspace`;
- works with a read-only root filesystem: only `/tmp` (tmpfs) and `/workspace` (volume) are written, and caches go to `/workspace/.cache`;
- has no setuid/setgid binaries and gives root no login shell or password ([`harden.sh`](harden.sh), run at the end of each stage; it fails the build if anything setuid remains). Apple `container` has no `no-new-privileges` flag, so this is what stands in for it there;
- idles on `sleep infinity`; the runner adds `--init`.

The base images are pinned by digest in the Dockerfile and in [`versions.json`](versions.json). `versions.json` also holds the published repository, tags, platforms (`linux/arm64`, `linux/amd64`), the digest of each published variant (`null` until the first release) and the cosign keyless identity that `publish.sh` signs with.

## Build locally

```bash
cd packages/sandbox
pnpm sandbox:build --backend docker --variant base          # tag psyche-sandbox:base-dev
pnpm sandbox:build --backend apple-container --variant core # uses `container build`
```

Or by hand: `docker build --target base -t psyche-sandbox:base-dev deploy/sandbox-image`.

Measured on an M5 Mac: `container build` of `core` took 117 s the first time (it boots a BuildKit VM); a Docker (OrbStack) build of `base` took about 3 minutes uncached.

## Publish

[`publish.sh`](publish.sh) does a multi-arch `buildx` build and push with provenance and an SBOM, signs the image with `cosign sign` (keyless) and writes the digest into `versions.json`. It needs a release workflow with registry credentials and an OIDC identity. That workflow does not exist yet and is a request to S00/S22. The runner prefers the pinned digest once it is set.
