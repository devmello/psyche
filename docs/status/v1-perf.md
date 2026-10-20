# v1.0 startup performance

**Owner:** S22. **Measured:** 2026-10-20, darwin-arm64 (Apple silicon), Node 24.22.0 (the bundled runtime).

**Setup**
- The built `psyched` runs straight from `apps/gateway/dist-bin` (`node deploy/scripts/build-psyched.mjs`). The dev Gateway runs as `node apps/gateway/src/main.ts`.
- Every run uses a temporary `PSYCHE_HOME` and `HOME` on port 0. No installed Gateway, LaunchAgent or packaged app is touched.

**Running the test**

```sh
PSYCHE_PERF_TESTS=1 pnpm --filter @psyche/acceptance-tests exec vitest run perf/process.perf.test.ts --project node
```

- It writes `out/perf/process.json`.
- It asserts the budgets below on the built bundle. A run without a bundle measures only the dev Gateway.
- The first-paint case needs Chrome (`PSYCHE_CHROMIUM_PATH` or `/Applications/Google Chrome.app`).

## Budgets and results

| Metric | Budget | Before | After (built) | Dev Gateway |
| --- | ---: | ---: | ---: | ---: |
| Warm boot to `/healthz` (median of 3) | < 1000 ms | ≈ 755 ms | **≈ 475 ms** | ≈ 600–670 ms |
| Cold boot to `/healthz` (empty `PSYCHE_HOME`, empty compile cache) | < 2000 ms | ≈ 1150 ms | 700–1015 ms | ≈ 700 ms |
| Idle RSS, 3 s after boot | < 250 MB | ≈ 340 MB | **≈ 148 MB** | ≈ 330 MB |
| Cold start to first chat token (scripted model) | < 3000 ms | not measured | **≈ 715 ms** | ≈ 760 ms |
| First chat token on a warm Gateway | none | not measured | 5 ms | 7 ms |
| Web client first contentful paint (headless Chrome) | < 1000 ms | not measured | **172 ms** | n/a |

**Where the numbers come from**
- **Before:** the same built bundle (after the size cut, #416) without this PR, measured by hand the same way: spawn → `"gateway listening"` → `/healthz`, then `ps -o rss`.
- **After:** `out/perf/process.json`, consistent with the hand measurements.
- **"First chat token"** uses the real process with an OpenAI-compatible server on loopback that streams a scripted reply (`PSYCHE_MODEL=lmstudio/scripted`). The client pairs the way the desktop does (handshake secret, Ed25519 device key).
  - So the figure is the Gateway's own cost, with no model latency in it.
  - The hosted-model figure stays with the live gates.
- **Window to first paint:** the packaged app is not launched on this Mac, so the measured part is the renderer's first contentful paint of the web client the Gateway serves.
  - Electron's window creation and the asar load are not in it.
  - Measuring the full number in the packaged app is the follow-up below.

## Where boot time goes (CPU profile and log timestamps, warm boot)

| Phase | Before | Notes |
| --- | ---: | --- |
| Node start and the static import graph | ≈ 650 ms | About 1,600 modules (77 npm packages plus the workspace sources). Module resolution and `package.json` reads ≈ 200 ms CPU, TypeScript stripping (amaro, wasm) ≈ 90 ms |
| `composeGateway` up to listen | ≈ 70 ms | Synchronous composition ≈ 36 ms. The sandbox backend probe (spawns `container`/`docker`) ≈ 30 ms wall |
| Migrations | ≈ 1 ms | Checked on every boot, and nothing runs when the schema is current. No change needed |

The packages that cost the most to import on their own:

| Package | ms | Why |
| --- | ---: | --- |
| playwright-core | 75 | eagerly imported |
| drizzle-orm | 69 | needed |
| @simplewebauthn/server | 45 | eagerly imported |
| @modelcontextprotocol/client | 25 | |
| ai | 25 | plus ≈ 5 ms per provider |
| @sinclair/typebox | 22 | |
| age-encryption | 19 | |

## Changes

| Change | Effect | Where |
| --- | --- | --- |
| Node's compile cache (V8 code and stripped TypeScript) in `~/Library/Caches/com.psyche.gateway/node-compile-cache`, outside the signed bundle. Only set when `HOME` is known and `NODE_COMPILE_CACHE` is not. Shared by `psyched` and `psyche` | warm boot −150 ms | launchers in `deploy/scripts/build-psyched.mjs` |
| `--max-semi-space-size=4` for `psyched`: a 4 MB young generation instead of V8's default, which grew to over 100 MB of reserved heap during boot. Boot time is unchanged (2, 4 and 8 MB were measured) | idle RSS ≈ 330 → ≈ 200 MB | `psyched` launcher |
| `playwright-core` loads when a browser session first needs Chromium | −75 ms import; less heap (idle RSS ≈ 200 → ≈ 148 MB together with the next row) | `packages/browser/src/drivers/playwright.ts` |
| `@simplewebauthn/server` loads on the first passkey call (server mode only) | −45 ms import | `apps/gateway/src/compose/passkeys.ts` |

## Not changed, and follow-ups

- **Window to first paint in the packaged app:** run once in desktop CI or on a spare Mac, which needs the app launched. Add it to `desktop.yml`'s nightly e2e, which already starts the packaged app.
- **The MCP client (25 ms) and the AI SDK providers (≈ 45 ms together):** they could load on first use too. Providers would then move the cost to the first model call, which is already on the cold-start-to-first-token path. Not worth it until boot matters more than first token.
- **The sandbox probe before listen (≈ 30 ms wall):** it could run after the Gateway listens, with `exec` registered once the probe answers. That is a small ordering change in `compose/sandbox.ts` (S21).
- **Module count:** the largest remaining cost is resolving and loading about 1,600 files. Bundling psyched into a few files would cut most of it, but the Gateway reads migrations and templates next to its sources (see `build-psyched.mjs`), so that is a larger change for after v1.0.
- **The dev Gateway** keeps Node's defaults (no compile cache, default heap), so its RSS is ≈ 330 MB. That is fine for development.
