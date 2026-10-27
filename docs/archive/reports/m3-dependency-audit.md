# Milestone 3 dependency audit

Date: 2026-10-20. Base: `origin/main` at `90a768a4`. Scope: docs/08-roadmap.md Milestone 3 "Hardening: dependency audit". Companion: [m3-threat-model-review.md](m3-threat-model-review.md).

## Summary

| Check | Result |
| --- | --- |
| `pnpm audit` (workspace) | 4 advisories (2 high, 2 moderate), none reachable from Psyche's code. After this PR: **1 moderate** (sprintf-js, no patch published, unreachable) |
| Licenses (prod tree, 542 packages) | No GPL / AGPL / LGPL / SSPL / BUSL / non-commercial. One non-open-source package (`@codesandbox/nodebox`, Sustainable Use License), **removed in this PR** |
| GitHub Actions | All 59 `uses:` pinned to full commit SHAs; top-level `contents: read` everywhere, writes granted per job; no `pull_request_target`; no `${{ github.event.* }}` in `run:` |
| Docker base images | Every product image digest-pinned and non-root. The published compose file defaults the gateway to `:latest` (#296) |
| Swift | `apps/mac-helper` has no third-party packages. Spikes pin `exact:` versions with a committed `Package.resolved` |
| Electron | 44.9.0, newest stable line, no open advisory (all GHSAs fixed at or below 44.5.0). Fuses hardened (`apps/desktop/forge.config.ts`) |
| Node | Images on 24.22.0. A HIGH-severity Node 24 security release is announced for 2026-10-21: re-pin then (#295) |
| Lockfile and installs | Committed; every CI and Docker install uses `--frozen-lockfile`; `allowBuilds` covers every package with install scripts |

## Fixed in this PR (mechanical)

| Id | Change | Verified |
| --- | --- | --- |
| DEP-4 | `pnpm-workspace.yaml` override `pptxgenjs>image-size: 2.0.4` (GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr). pptxgenjs 4.0.1 declares `image-size ^1.2.1` but its dist never loads it | `@psyche/viewers` tests (22 files, 188 tests, real-browser files excluded) |
| DEP-2 | Override `@codesandbox/sandpack-client>@codesandbox/nodebox: "-"`. nodebox is under the CodeSandbox Sustainable Use License (non-commercial use and distribution only) and was redistributed in the gateway image. Psyche imports only `@codesandbox/sandpack-client/clients/runtime` (`packages/viewers/src/react/sandpack.ts`); nodebox is reached only from `clients/node` | viewers tests; `@psyche/web` production build |
| DEP-6 | Remove `drizzle-kit` from `@psyche/db` devDependencies: nothing uses it, and it pulled `esbuild 0.18.20` (GHSA-67mh-4wv8-2f99) through the deprecated `@esbuild-kit/*` | `@psyche/db` typecheck and tests (9 files, 98 tests) |
| DEP-7 | `packageManager: "pnpm@12.4.1+sha512.<hex>"` (the hex of `npm view pnpm@12.4.1 dist.integrity`), so `corepack enable` in the Dockerfiles verifies pnpm | `pnpm install --frozen-lockfile` |

## `pnpm audit` detail

| Package | Path | Prod/dev | Severity | Advisory | Status |
| --- | --- | --- | --- | --- | --- |
| image-size 1.2.1 | viewers > pptxgenjs > image-size | prod | high ×2 | GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr | fixed (override 2.0.4) |
| esbuild 0.18.20 | db > drizzle-kit > @esbuild-kit/core-utils > esbuild | dev | moderate | GHSA-67mh-4wv8-2f99 | fixed (drizzle-kit removed) |
| sprintf-js 1.0.3 | viewers > mammoth > argparse > sprintf-js | prod | moderate | GHSA-hp3w-g68c-fv3c | **no patch exists**; only mammoth's CLI uses argparse. Accepted risk, #299 |

Other notes: SheetJS comes from the vendor tarball (`cdn.sheetjs.com/xlsx-0.20.3`, integrity in the lockfile), which `pnpm audit` and registry bots skip; 0.20.3 is the newest and both SheetJS CVEs are fixed by 0.20.2 (ADR-013). pptxgenjs lists `https` (an npm placeholder) and `@types/node` as runtime dependencies.

## License review

MIT 433, Apache-2.0 54, ISC 19, BSD-3-Clause 16, BSD-2-Clause 8, plus single packages under 0BSD, MIT-0, BlueOak-1.0.0, MIT AND Zlib, AFL-2.1 OR BSD-3-Clause, MPL-2.0 OR Apache-2.0 (dompurify), MPL-2.0 (lightningcss, see DEP-12), CC-BY-4.0 (caniuse-lite data), MIT OR GPL-3.0-or-later (jszip; MIT taken). Flagged and removed: `@codesandbox/nodebox` (DEP-2). Dev-only: `@modelcontextprotocol/server-filesystem` ships without a LICENSE file (upstream MIT). ADR-013 exclusions (Handsontable, HyperFormula, BlockNote, iframe-resizer, ONLYOFFICE, Monaco, WebContainers, npm `xlsx@0.18.5`) are all absent. Every workspace package declares Apache-2.0.

## GitHub Actions

All 59 `uses:` across `ci.yml`, `desktop.yml`, `release.yml`, `security.yml` are pinned to 40-character SHAs with version comments. Job-scoped write permissions are each justified (changesets PR, GHCR push and cosign signing, the sandbox digest PR, `gh release create`). `persist-credentials: false` on 15 of 16 checkouts (the changesets job needs its token). Gap: nothing keeps these pins fresh and CI has no audit gate (#297).

## Docker images and compose

| Location | Image | Digest | Non-root |
| --- | --- | --- | --- |
| deploy/Dockerfile | `node:24-bookworm-slim` / `node:24-bookworm` (24.22.0) | yes | yes (`USER 10001`) |
| deploy/sandbox-image/Dockerfile | `node:24.22.0-trixie-slim`, `ghcr.io/astral-sh/uv:0.13.1` | yes | yes (`USER 1000`) |
| tests/integration/server-mode/Dockerfile | `node:24-bookworm` | yes | yes |
| spikes/sandbox-backends/Dockerfile | `node:24-trixie-slim` | **no** (spike) | yes |
| deploy/docker-compose.yml `gateway` | `ghcr.io/devmello/psyche-gateway:latest` default | **no** (#296) | yes, read-only, caps dropped |
| deploy/docker-compose.yml `tailscale` | `tailscale/tailscale:v1.104.1` | yes | **root, no hardening** (#298) |
| deploy/docker-compose.yml `cloudflared`, `browser` | pinned | yes | yes; but `browser` runs `npx -y playwright@1.64.1` at start (#298) |

## Swift, Electron, Node

- `apps/mac-helper/Package.swift`: swift-tools 6.0, macOS 15, local targets only. `spikes/dictation` pins FluidAudio 0.17.7 and WhisperKit 1.1.1 `exact:` with a committed `Package.resolved`.
- Electron `44.9.0` exact; npm `latest` is 44.9.1 (build changes only). Supported lines 44/43/42. Fuses: RunAsNode off, cookie encryption on, NODE_OPTIONS and inspect off, ASAR integrity on, app from ASAR only.
- Node: `engines >=24.0.0` with `engineStrict`, `.nvmrc` `24` for CI, images 24.22.0. Oct 21 security release: #295.

## Findings and issues

| Id | Sev | Finding | Owner | Issue / PR |
| --- | --- | --- | --- | --- |
| DEP-1 | high | Node 24 HIGH security release on 2026-10-21; re-pin every Node image digest | S22, S21 | #295 |
| DEP-2 | medium | Non-open-source nodebox redistributed in the gateway image | S13 | fixed here |
| DEP-3 | medium | Published compose defaults to `:latest` (docs/05 §11 says digests) | S22 | #296 |
| DEP-4 | medium | image-size HIGH DoS advisories (unreachable) | S13 | fixed here |
| DEP-5 | medium | No Dependabot / Renovate, no audit gate in CI | S00 | #297 |
| DEP-6 | low | Unused drizzle-kit pulls vulnerable esbuild (dev) | S00 | fixed here |
| DEP-7 | low | `packageManager` without integrity hash | S00 | fixed here |
| DEP-8 | low | Playwright sidecar `npx -y` at start | S22 | #298 |
| DEP-9 | low | Tailscale service unhardened in the published compose | S22 | #298 |
| DEP-10 | low | sprintf-js advisory, no patch (accepted risk) | S13 | #299 |
| DEP-11 | low | No `minimumReleaseAge` cool-down | S00 | #299 |
| DEP-12 | info | vitest / vite / lightningcss in the gateway prod tree via an optional peer | S08 | #299 |
| DEP-13 | info | `allowBuilds: electron: true` looks stale | S00 | #299 |
| DEP-14 | info | Electron 44.9.0 clean; watch for the Node fix | S11 | #299 |
| DEP-15 | info | Spike Dockerfile tag-only | S21 | #299 |
