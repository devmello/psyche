# App size, 2026

Goal: Psyche.app 300–400 MB installed, under 500 MB all told (it was 651 MB; the arm64 DMG 297 MB).
Sizes are MiB as `du -sh` and Finder show them; `deploy/size-budget.json` holds the limits the
build enforces (`psychedMB`, `appMB`, `dmgMB`): `build-psyched.mjs` checks the Gateway bundle,
`make-dmg.sh` the app and the DMG, both through `deploy/scripts/size-budget.mjs`. Over the limit the
build fails; a PR that needs more raises the number and says why.

## Where the bytes were (arm64, 0.3.0-alpha.0)

| Part | MiB |
|---|---|
| `Contents/Frameworks` (Electron 44) | 240 |
| `Resources/psyched/runtime/node` (the Gateway's Node 24.22.0) | 93 |
| `Resources/psyched/app/node_modules` | 200 |
| `Resources/psyched/app/apps` (web client 33, Gateway 2.4) | 35 |
| `Resources/psyched/app/packages` | 14 |
| `Resources/app.asar` | 32 |
| `PsycheHelper.app` | 30 |

`node_modules`: onnxruntime-node 85 (two 44 MB copies of one dylib), pdfjs-dist 17,
better-sqlite3-multiple-ciphers 16, better-sqlite3 12, playwright-core 11, domino 8.6, then
`ai`, `zod`, drizzle at 5–7 each.

## Phase 1: prune what is never loaded (no behaviour change)

`deploy/scripts/prune-package-waste.mjs`, run by `build-psyched.mjs` after the server-subset prune:

- **better-sqlite3 and its cipher fork** (28 MB): the SQLite amalgamation (`deps/`), the addon
  sources and node-gyp leftovers (`build/`) go. Both ship `prebuilds/darwin-<arch>.node`, the only
  file the lib loads.
- **onnxruntime-node** (44 MB): the dylib shipped twice (`libonnxruntime.1.dylib` and
  `.1.30.0.dylib`, 44 MB each); the short name is now a link to the long one.
- **pdfjs-dist** (≈ 8 MB): the Gateway imports only `legacy/build/pdf.mjs` (`packages/files`
  text extraction). The browser `build/`, `web/` viewer, `image_decoders/`, `types/` and the
  minified and sandbox copies go; cMaps, standard fonts and wasm decoders stay.
- **playwright-core** (4 MB): `lib/vite`, the trace viewer, recorder, dashboard and report UIs.
- **domino** (8 MB, mostly its own `test/` and `.yarn`): pruned by the docs/tests rule below.
- **Every dependency**: top-level `test`, `docs`, `examples`, `.github`, …, any `*.md` except
  licences, sourcemaps, declaration files, lint and tsconfig dotfiles.
- **Workspace sources** in the bundle: `*.test.ts`, `test/` and `vitest.config.ts` of each package.
- **Chromium and macOS locale folders** keep the 11 UI languages (`en` plus the ten catalogues in
  `packages/ui/src/i18n/messages/locales`) and drop the rest and the gender variants. A test keeps
  the list in step with the catalogues. It costs about 10 MB more than English only, which is
  what bought translated native menus and spell check.
- The smoke (`build-psyched.mjs --smoke`, or `--smoke-only` on a built bundle) now also loads both
  SQLite builds, sqlite-vec, SQLCipher, playwright-core, turndown and a pdf.js parse with the
  bundle's own Node.

Checked and left alone:

- **Two SQLite packages.** `better-sqlite3` serves the memory, search, connector and task stores;
  `better-sqlite3-multiple-ciphers` serves only the vault (SQLCipher). The fork is API-compatible,
  but moving every store onto it swaps SQLite's build under all data and sqlite-vec for a ~2 MB
  saving, since `deps/` is gone either way. Not a safe drop-in for that gain.
- **playwright-core** is needed: browser sessions import it lazily (`packages/browser`).
- **domino** is needed: turndown (HTML to Markdown in the web connector) parses with it.

### Result

| arm64 | before | after phase 1 |
|---|---|---|
| `Resources/psyched` | 344 MiB | 245 MiB |
| Psyche.app installed | 651 MiB | 561 MiB |
| DMG | 283 MiB (297 MB) | 249 MiB (261 MB) |

## Phase 2: onnxruntime on demand (tried, then reversed)

#926 dropped `libonnxruntime` (44 MiB installed, about 11 MiB of the DMG, which compresses it ~3.5:1)
from the Apple silicon app and downloaded Microsoft's pinned release the first time on-device semantic
search was turned on. It worked (installed from the real archive and ran an inference), taking
Psyche.app from 561 to 519 MiB, **but not in a notarized build**: the release build uses the hardened
runtime without `disable-library-validation` (`apps/desktop/entitlements.plist`, on purpose). Measured
on the bundled Node copied and re-signed with `--options runtime` and the app's entitlements, it
refuses to `dlopen` a library signed by anyone else ("library load disallowed by system policy") and
loads it only once the Node binary has `com.apple.security.cs.disable-library-validation`.
Microsoft's dylib is signed by Microsoft (team UBF8T346G9), so the downloaded runtime would not have
loaded in a Developer ID build unless that one binary got the entitlement.

**Decision (owner): ship the library inside the app and keep library validation.** The download path
(`packages/search/src/ort-runtime.ts`, `apps/gateway/src/compose/ort-runtime.ts`) is removed. The
toggle Settings → Search → Semantic (on-device) and the embedding model download are as before. What
stays from phase 1: only `darwin/<arch>` of `bin/napi-v6` ships, and the library's second copy is a link
to the first (`libonnxruntime.1.dylib` → `.1.30.0.dylib`), so the app carries one 44 MiB library, signed
with the app like every other native file. The Intel build keeps its `darwin/x64` runtime the same way.

If the size has to come out again, the options are: give `Resources/psyched/runtime/node` the
entitlement through a second entitlements file in `signing-config.ts`' `optionsForFile` (the download
code is in the history of #926), or load the model with a smaller runtime. Neither is needed for the
under-500 MiB goal.

## Phase 3: one Node runtime instead of two

Today Psyche.app holds Electron's Node (inside `Electron Framework`) and a second, official Node 24.22.0
(`Resources/psyched/runtime/node`, 93 MiB installed, 34 MiB gzip) that runs the Gateway LaunchAgent.
Everything below was measured on this machine; sizes are from the phase 2 build (psyched 202 MiB), where onnxruntime was not bundled, so add 44 MiB to the installed totals now that it ships again.

### Can the LaunchAgent run on Electron's Node?

Technically yes.

| Question | Finding |
|---|---|
| Node version | Electron 44.9.0 embeds **Node 24.22.0**, the same as the pinned runtime (`deploy/Dockerfile` pin). V8 differs (Electron 15.2). |
| Type stripping, flags | `ELECTRON_RUN_AS_NODE=1 Electron --max-semi-space-size=4 --disable-warning=ExperimentalWarning apps/gateway/src/main.ts` boots the Gateway as is: `/healthz` ok, and `node:module` has `stripTypeScriptTypes`. No prebuilt JS needed. |
| Native ABI | Electron's `NODE_MODULE_VERSION` is 149 (Node 24: 137), but the Gateway's three addons (better-sqlite3, the cipher fork, onnxruntime's binding) are all **N-API** (`nm -u`: 60–63 `napi_*` symbols, no V8 ones), so nothing is rebuilt. sqlite-vec is a plain dylib loaded by SQLite. The same smoke (both SQLite builds, sqlite-vec, SQLCipher, playwright-core, turndown) passes under Electron's Node. node-pty is desktop-only and already built for Electron by Forge. |
| Idle memory | Gateway RSS after boot plus 4 s: 197 MB on Electron's Node, 205 MB on the bundled Node. No penalty. |
| Survives ⌘Q | The agent is a separate launchd job, so quitting the UI does not touch it, as today. |
| Notarization | No new signing work: the binary is already inside the sealed app and signed with it. |
| Windows later | The same mechanism exists (`ELECTRON_RUN_AS_NODE` on `Psyche.exe`, started by a Task Scheduler entry or service) with the same fuse trade-off below. |

### Why not now: the `RunAsNode` fuse

`apps/desktop/forge.config.ts` turns the **RunAsNode fuse off** (`@electron/fuses read` on the built
app says "RunAsNode is Disabled"), and with it off `ELECTRON_RUN_AS_NODE` is ignored. Turning it on
means any local process that can exec the signed binary runs arbitrary JavaScript with the app's
identity and entitlements: microphone, Calendar, Contacts, Apple Events (`entitlements.plist`), and
the TCC grants the owner gave Psyche. That is the case the fuse exists for, and Psyche's whole premise
is that its secrets and grants stay behind the Gateway's checks. Fuses belong to `Electron Framework`,
so a helper inside the same bundle does not escape them; a second framework copy would cost 240 MiB.

Other costs of the swap, none blocking on their own:

- Three places spawn `process.execPath` expecting Node (`packages/plugins/src/host.ts`,
  `packages/model-router/src/cli/adapter.ts`, `packages/vault/src/payments/link.ts`). On Electron they
  would launch a second copy of the app unless each passes `ELECTRON_RUN_AS_NODE=1`; the failure is a
  window, not an error.
- The CLI launcher (`psyche`) and the plist template `Program` would point into the app's main
  executable. An app update that replaces `Psyche.app` under a running agent is as it is today.
- Electron prints `task_name_for_pid: (os/kern) failure (5)` once at start in this mode (seen when run from a shell, not under launchd); the Gateway was unaffected.
- The agent's identity to macOS becomes "Psyche" itself instead of an unnamed `node`, which changes
  what Login Items and TCC show for the Gateway.

An in-app daemon mode (launchd runs `Psyche --gateway` with the fuse off, main process headless,
Gateway in-process or in a `utilityProcess`) avoids the fuse but starts Chromium's browser process
for nothing (Dock icon unless `LSUIElement`, single-instance lock against the UI, extra RSS), and it
ties the Gateway to Electron's main loop. Not low-risk either.

**Recommendation: do not enable the fuse, and do not implement the swap in this series.** It is the
only change that reaches the 300–400 MiB target, so it is worth the owner's decision on the fuse; if
the owner accepts it, the work is: fuse on (or the daemon mode), `ELECTRON_RUN_AS_NODE` in those three
spawns and in both launchers, and a packaging test that boots the Gateway on the app's binary.

### Done instead: the Gateway and the CLI are bundled with esbuild

`deploy/scripts/bundle-gateway.mjs` (run by `build-psyched.mjs`) bundles three entries into the exported
tree, minified, ESM, Node 24 target:

- `apps/gateway/dist/main.mjs` (5.8 MB) is psyched;
- `apps/gateway/dist/extract-worker.mjs` is the document-extraction worker thread (`@psyche/files`);
- `apps/cli/dist/main.mjs` (0.6 MB) is `psyche`.

Kept external, as real packages in `node_modules`: the native addons (`better-sqlite3`, the cipher fork,
`sqlite-vec`, `onnxruntime-node`) and the libraries that read their own files at run time (`pdfjs-dist`,
`playwright-core`). Everything else, the workspace and pure-JS dependencies, is inside the bundles. Then
`discardSources` deletes every workspace source (only the assets below survive), links the external
packages into `app/node_modules` and removes every pnpm store entry they do not reach, plus the
workspace links that dangle (codesign cannot seal a link to nothing).

**Assets root.** The 11 modules that located migrations, templates, skills, the web client, the sandbox
image context and the MCP bridge through `import.meta.url` now ask `@psyche/assets` (`packages/assets`).
`assetPath("packages/db/migrations")` is the same relative path below one root in a checkout and in the
bundle: the root is `PSYCHE_ASSETS_ROOT`, else three directories above a bundle (each bundle's banner
sets `globalThis.__PSYCHE_BUNDLE_URL__`), else the repository root. `entryUrl()` does the same for the
extraction worker. What stays next to the bundles: `skills/`, `templates/`, `deploy/sandbox-image/`,
`apps/web/dist/`, the three `migrations/` folders and `mcp-stdio-bridge.mjs`.

**Smoke.** `psyched --bundle-check` (`apps/gateway/src/bundle-check.ts`) opens a fresh database and runs
all migrations, reads the connector and notification migrations and the templates, loads every bundled
skill, finds the web client, the sandbox context and the bridge, and extracts a PDF through the worker
thread. `build-psyched.mjs --smoke` runs it with the bundle's own Node, after the `/healthz` boot, plus
a load of each external package (SQLite, sqlite-vec, SQLCipher, playwright-core, onnxruntime).
`deploy/scripts/upgrade-roundtrip.mjs` (CLI pairing, online backup, restore, second boot) also passes
against the bundle's launchers.

Result: `Resources/psyched` 245 → 196 MiB, Psyche.app 561 → 510 MiB, DMG 247 → 198 MiB.

### Where that leaves the target (arm64, installed)

| | MiB |
|---|---|
| Original | 651 |
| After phase 1, onnxruntime shipped | 561 |
| + esbuild Gateway bundle (measured) | **510** |
| + Electron's Node instead of the bundled one (fuse; owner said no) | ≈ 417 |

With the library shipped and the fuse off, the installed app is 510 MiB and the DMG 198 MiB. Under
500 needs one of the smaller things below; 300–400 needs the second Node gone:

- `libvk_swiftshader.dylib` (16 MiB): the software Vulkan fallback for machines without a usable GPU.
  Removing it risks a blank window on those; test with `--disable-gpu` first.
- The web client (`Resources/psyched/app/apps/web/dist/assets`, 31 MiB of JS in 358 chunks, mostly
  syntax-highlighter grammars and locale data loaded on demand) and the desktop renderer in
  `app.asar` (32 MiB) are two builds of mostly the same UI; serving one copy, or dropping rarely used
  grammars, is a bigger saving than anything left in `node_modules`.
- A Node built `--without-intl` / small-ICU and without the inspector would be roughly 40–50 MiB
  smaller than the official 93 MiB binary, at the price of building and pinning our own runtime in CI.

## Helper: strip before signing

`apps/mac-helper/scripts/build-app.sh` (release) writes a dSYM next to the bundle
(`dist/PsycheHelper.app.dSYM`, not shipped), then runs a full `strip` on the copy inside the app
before `codesign`. `psyche-helper` goes from 29.7 to 10.1 MiB (31,145,840 to 10,632,096 bytes):
`__LINKEDIT` (symbols) shrinks from 21.0 to 1.4 MiB, `__TEXT` is unchanged. Runtime RAM is
unchanged. `PSYCHE_HELPER_STRIP=x` (strip -x) or `none` overrides it.
