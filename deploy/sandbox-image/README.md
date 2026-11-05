# Sandbox image

**Owner:** S21. Used by [`@psyche/sandbox`](../../packages/sandbox/README.md); the contract is in [security §5.1](../../docs/05-security-and-permissions.md) and K8 in the [feature spec](../../docs/03-feature-spec.md).

| target | contents | size (arm64, uncompressed) |
|---|---|---|
| `core` | Debian 13 (node:24 trixie-slim), Node 24, bash, Python 3 + uv, git, ripgrep, jq, curl, procps | 618 MB |
| `base` | core + pandoc, poppler-utils, pdftk-java, ffmpeg (the default runtime image) | 1.76 GB |
| `full` | base + LibreOffice writer, calc and impress (no GUI) | 2.3 GB |
| `desktop` | full + Xvfb, a private D-Bus, AT-SPI, Firefox ESR, a file manager, LibreOffice with its GUI, and the Linux helper (the separate desktop, Linux only) | 2.29 GB (amd64, measured) |

Every target:

- runs as `psyche`, UID/GID 1000, with `HOME=/workspace`;
- works with a read-only root filesystem: only `/tmp` (tmpfs) and `/workspace` (volume) are written, and caches go to `/workspace/.cache`;
- has no setuid/setgid binaries and gives root no login shell or password ([`harden.sh`](harden.sh), run at the end of each stage; it fails the build if anything setuid remains). Apple `container` has no `no-new-privileges` flag, so this is what stands in for it there;
- idles on `sleep infinity`; the runner adds `--init`.

The base images are pinned by digest in the Dockerfile and in [`versions.json`](versions.json). `versions.json` also holds the published repository, tags, platforms (`linux/arm64`, `linux/amd64`), the digest of each published variant (`null` until the first release) and the cosign keyless identity that `publish.sh` signs with.

## The desktop target (separate desktop, Linux)

`desktop` is not a sandbox for commands. It is the image the Linux **separate desktop** runs (`packages/sandbox/src/desktop.ts`, [design §8](../../docs/design/linux-desktop-2026.md)): a graphical desktop that the Gateway drives through the helper inside it. It keeps the rules above (UID 1000, read-only root, `/tmp` a tmpfs, `/workspace` a volume, no setuid) and adds: no network at all, one read-only socket mount for the Gateway, a single-use pairing token in `PSYCHE_GUEST_TOKEN`, and shared folders only at `/shares/<name>`.

`desktop/entrypoint.sh` starts a private session bus, Xvfb on `:1`, the AT-SPI bus, then the helper in the foreground (the container exits if it does). The helper is not built here: stage the Linux helper binary at `desktop/psyche-helper` (git-ignored) first. Its checksum is **required**: the build fails without `--build-arg HELPER_SHA256=<sha256>` (a local dev build may skip it with `--build-arg ALLOW_UNVERIFIED_HELPER=1`; `publish.sh` never does and needs `PSYCHE_HELPER_SHA256` for this variant):

```bash
cp apps/linux-helper/target/release/psyche-helper deploy/sandbox-image/desktop/psyche-helper
podman build --target desktop   --build-arg HELPER_SHA256=$(sha256sum deploy/sandbox-image/desktop/psyche-helper | cut -d" " -f1)   -t psyche-sandbox:desktop-dev deploy/sandbox-image
```

`versions.json` lists `desktop`, but `publish.sh` and the release workflow do not publish it by default yet (their default variants are `core base full`); publishing it needs the helper binary in the release job.

## Build locally

```bash
cd packages/sandbox
pnpm sandbox:build --backend docker --variant base          # tag psyche-sandbox:base-dev
pnpm sandbox:build --backend apple-container --variant core # uses `container build`
```

Or by hand: `docker build --target base -t psyche-sandbox:base-dev deploy/sandbox-image`.

Measured on an M5 Mac: `container build` of `core` took 117 s the first time (it boots a BuildKit VM); a Docker (OrbStack) build of `base` took about 3 minutes uncached.

## Publish (release tags only)

The `sandbox-image` job in [`.github/workflows/release.yml`](../../.github/workflows/release.yml) runs [`publish.sh`](publish.sh) on every `v*` tag. Nothing has been published yet: the first real run is the next version tag, and until then every `digest` in `versions.json` is `null` and the runner uses the local dev tag.

For each of `core`, `base` and `full`, in that order (one job, so each target reuses the previous one's layers), `publish.sh`:

1. builds `linux/arm64` + `linux/amd64` (from `platforms`) with `docker buildx build --push`, provenance (`mode=max`) and an SBOM, passing the digest-pinned `baseImages` as `NODE_IMAGE` / `UV_IMAGE` build args (it refuses to run if they are not pinned or differ from the Dockerfile defaults) and `SOURCE_DATE_EPOCH` from the commit;
2. tags it `<version>` (base) or `<version>-<variant>`, where the version is the release tag without the `v`;
3. reads the pushed manifest-list digest from the buildx metadata file and signs `repository@digest` with `cosign sign --yes` (keyless, GitHub OIDC);
4. writes `version`, `variants.<v>.tag` and `variants.<v>.digest` into `versions.json` with `jq`, leaving everything else alone.

The workflow then runs `cosign verify` on all three digests against `signing` in `versions.json`, attaches the updated file to the GitHub release as `sandbox-image-versions.json`, and opens a PR against `main` that copies `version` and `variants` into `versions.json` (a tag build cannot push to `main`). That PR is opened with `GITHUB_TOKEN`, so its CI does not start on its own (close and reopen it), and the repository must allow GitHub Actions to create pull requests. Once it merges, the runner prefers the pinned digest.

A manual run with `dry_run` ticked, or a manual run from a branch, only runs `publish.sh --dry-run` (a manual run on a `v*` tag with `dry_run` unticked publishes, which is how to retry a failed release). Locally:

```bash
deploy/sandbox-image/publish.sh --dry-run --version 0.2.0 core base full   # prints the commands; needs bash + jq
```

Apt packages are not snapshot-pinned, so two builds of the same commit are not byte-identical; the pinned digest in `versions.json` is what makes a run reproducible.

## Verify

The signer is the release workflow on a version tag; `versions.json` `signing` holds the exact identity:

```bash
cd deploy/sandbox-image
cosign verify "$(jq -r .repository versions.json)@$(jq -r .variants.base.digest versions.json)" \
  --certificate-identity-regexp "$(jq -r .signing.certificateIdentityRegexp versions.json)" \
  --certificate-oidc-issuer "$(jq -r .signing.certificateOidcIssuer versions.json)"
```

The regexp accepts only `https://github.com/devmello/psyche/.github/workflows/release.yml@refs/tags/vX.Y.Z[-pre]`: a signature from any other workflow, branch or fork fails.
