# Lightweight Psyche, 2026

Goal: a Psyche that costs little to keep running. **Runtime RAM comes first, installed size second**:
no change may buy disk with idle memory, and nothing may weaken code signing. The Electron RunAsNode
fuse stays off, there is no Electron "gateway mode", and the Gateway keeps its own Node
([app-size-2026.md](app-size-2026.md) has the size side and why).

This document has the measured baseline (phase A), the ranked plan (phase B) and, as PRs land, their
before/after numbers (phase C).

## How it was measured (2026-10-26, arm64, macOS 27, Node 24.18, Electron 44.9)

- **Metric.** macOS *physical footprint* (`footprint <pid>`): the memory a process costs, including
  compressed pages. RSS is misleading on macOS: the same idle Gateway reads 205 MB RSS at +4 s and
  80 MB a minute later, while its footprint does not move. RSS is quoted only for comparison with
  older numbers.
- **Settled idle.** Footprint 60 s after `/healthz`, after a forced full GC at 40 s
  (`--expose-gc` and a preload). Without the GC the number depends on when V8's idle GC fires.
  With it, three runs agree to ±1 MB.
- **Gateway.** Started with the production flags (`--max-semi-space-size=4`), a throwaway
  `PSYCHE_HOME` under `/tmp` and its own port, and a fake model: `PSYCHE_MODEL=lmstudio/stub` against
  a loopback OpenAI-compatible stub (the `.env` Anthropic key was rejected, and the stub keeps model
  latency out of the numbers). Two builds: the source tree run by Node type stripping (what shipped
  before #929), and the esbuild bundle from #929.
- **Desktop.** The renderer and main bundles built by `electron-forge package` (`.vite/`), run on
  the repository's unfused Electron with `PSYCHE_GATEWAY_MODE=external` against the bundled
  Gateway, with a scratch `HOME`, scratch userData and `--use-mock-keychain`. They also run in the
  app's perf mode (no psyche:// handler, global shortcuts, updater or helper) with
  `PSYCHE_PERF_HOLD=1`, a new switch that keeps the run alive after first paint (see phase C). The
  scenarios were driven over the main-process inspector and CDP. The inspector adds a few MB to the
  main process; the idle row below is from a run without it. `/Applications/Psyche.app` and the
  `com.psyche.gateway` LaunchAgent were never touched.
- **Scripts** are in the session notes folder (`lightweight-2026/`): `ab2.sh` (settled idle),
  `sample.sh` (per-process table), `cdp.mjs`, `impcost.mjs` / `inc.mjs` (heap cost of an import).

## Phase A: baseline

### The Gateway

| Settled idle | Footprint | JS heap used | Notes |
|---|---|---|---|
| Source tree, type stripping (before #929) | **152 MB** | 58 MB | 3 runs: 152 / 151 / 152 |
| esbuild bundle (#929, on main) | **127 MB** | 31 MB | 3 runs: 127 / 127 / 127 |
| Bundle, after one chat turn | 126 MB | 31 MB | no growth from a turn |

- **The "205 MB idle" figure is RSS at +4 s**, during startup. It is confirmed as a startup peak
  (157–201 MB RSS at +5 s in five runs), not as idle cost.
- **#929 already saved 25 MB footprint and 27 MB of heap**, more than its size win suggests. Two
  costs went away:
  - Type stripping loads Node's `amaro` (a 3.6 MB JS bundle plus its wasm memory) and keeps it
    resident. A one-line `.ts` file costs +25 MB RSS and +4 MB heap over the same `.mjs`.
  - The stripped sources keep every comment and type position as blanks: 13 MB of ESM source in
    1,580 modules, plus 252 CommonJS ones. The minified bundle is 5.8 MB.
- **Where the bundled Gateway's 127 MB goes:**
  - V8 heap: 45 MB, of which 31 MB is live objects.
  - Native malloc: about 73 MB, of which 25 MB is freed but retained by the allocator
    (`Malloc Small (empty)`).
  - Page tables and dyld data: about 8 MB.
  - Under memory pressure macOS reclaims the retained pages (one run fell to 83 MB on its own).
- **Not worth it (measured, no change):** `--v8-pool-size=1` (128 MB), `MallocNanoZone=0` (126),
  `--max-old-space-size=96` (129; it caps growth and does not lower idle), and an ASCII-only bundle
  (127). `--single-threaded-gc` is worse (143). SQLite holds about 1.6 MB of page cache at idle, so
  `cache_size` / `mmap_size` tuning has nothing to win at idle.

**What the Gateway loads at boot and does not need yet.** Each figure below is the heap a library
adds on top of what is always loaded (`zod`, `ai`, `@ai-sdk/provider-utils`, typebox, `ws`),
measured unbundled, so they are upper bounds:

| Library | Heap | Used for | Needed at boot? |
|---|---|---|---|
| `@modelcontextprotocol/client` | 4.2 MB | MCP host, connectors | only with an MCP server configured |
| AI SDK providers other than the one in use (google, anthropic, openrouter, ollama) | 3.3 MB | `model-router/factory.ts` imports all six statically | one or two |
| `grammy` | 3.3 MB | Telegram channel adapter | only with Telegram configured |
| `turndown` + domino | 1.8 MB | `connectors/web/html.ts` | on first web fetch |
| `age-encryption` | 3.1 MB | vault | yes |
| luxon, cron-parser, yaml | 2.6 MB | scheduler, skills | yes |

playwright-core, pdfjs-dist and onnxruntime are **not** loaded at boot: they are already behind
dynamic imports. The bundle is one file with no code splitting, so inside it a dynamic `import()`
saves the module's evaluation but not its source text, which stays in the 5.8 MB string.

### The desktop app

Settled per-process footprint (MB). The main chat window is open in every row.

| Scenario | Main | Renderer: chat | Renderer: screen-ask panel (warm) | GPU | Network | Gateway | Total |
|---|---|---|---|---|---|---|---|
| Idle, no inspector | 88–92 | 63–66 | 70–72 | 12 | 7 | 127 | ≈ 370 |
| After one chat turn | 95 | 102 | 60 | 12–155 | 7 | 126 | ≈ 400–545 |
| Window closed to the menu bar | 91 | 91 (hidden) | – | 154 | 7 | 85* | 428 |
| Window destroyed (experiment) | 90 | – | – | 45 | 7 | 86* | 228 |
| Browser pane, 2 background tabs | 98 | 79 | 71 | 123–289 | 10 | 91* | 533 + tabs |

\* Under memory pressure from other work on the machine, the Gateway's footprint fell below its
settled number. The Gateway row above is the reliable one.

- **Two renderers at idle.** The screen-ask panel is created hidden at launch and kept warm, so ⌥⇧Space
  opens instantly. It costs 70 MB while it renders nothing: its route goes through the same entry
  (`apps/desktop/src/renderer/main.tsx`) as the main app, which statically imports the whole
  `@psyche/web/compose` barrel, so it parses the 8 MB `index` chunk and holds a 24 MB JS heap.
  An empty renderer with the same preload is 19 MB. The dictation HUD uses the same entry.
- **The main window when hidden** keeps its renderer (91 MB). In one run the GPU process also kept
  110 MB of IOSurfaces (compositor buffers) after the window was hidden. GPU footprint varies with
  whether the window is on screen at all (12–155 MB while visible across runs), so that part is not
  reproducible on demand.
  - Destroying the window freed 200 MB (428 → 228).
  - Recreating it took **456 / 515 / 610 ms** until the transcript and composer were on screen,
    measured with the inspector attached. Showing a hidden window takes 2 ms.
- **Browser tabs** cost 20 MB (example.com) and 47 MB (a Wikipedia article) each, as their own
  renderers. Tab views keep `backgroundThrottling: false` on purpose (the agent drives them off
  screen).
- **The main process** shows about 90 MB, 32 MB of it in two `CG Image` regions. That is very likely
  the dev-only Dock icon: `app.dock.setIcon` runs with the 1024² PNG only when unpackaged. The
  packaged main process is probably about 60 MB; this needs checking on a packaged build.
- **PsycheHelper** (installed copy, read only): 25 MB footprint, 11 MB RSS.
- **The renderer bundle**: the main `index` chunk is 8 MB. Univer (5.5 MB), MapLibre, PDF.js and the
  highlighter grammars are already separate chunks loaded on demand.

### Installed size (from app-size-2026.md, after #929)

Psyche.app 510 MiB, DMG 198 MiB; `deploy/size-budget.json` enforces 205 / 530 / 210.

## Phase B: the plan, ranked by measured saving

RAM items first. "Saving" is footprint unless it says heap.

| # | Change | Saving | User-visible trade-off | Risk | Status |
|---|---|---|---|---|---|
| 1 | Gateway bundled with esbuild | −25 MB Gateway, always | none | done | **#929, merged** |
| 2 | Release the main window's renderer while the app sits in the menu bar | −90 MB renderer, plus GPU surfaces when retained (up to −200 MB measured) | reopening after the release takes ≈ 0.5 s instead of instant | medium (window lifecycle, state restore) | **needs the owner's call** (> 300 ms) |
| 3 | A lean entry for the screen-ask panel and dictation HUD (only their components, not the app barrel) | −35 to −50 MB while the panel is warm, which is always when Ask about screen is on | none (it opens faster cold) | low | **#933**: 72 → 54 MB |
| 4 | Discard background browser tabs after 15 minutes idle (never the active tab, a task's tab, a tab under take-control or in use over CDP, a popped-out, loading or audible tab) | measured: a Wikipedia tab's 51 MB freed; −20 to −50 MB per tab | the tab reloads when shown again (≈ 1 s for Wikipedia), losing scroll and form state | owner approved; **done** |
| 5 | Lazy Gateway subsystems: MCP client, AI SDK providers on first use, grammy, turndown, with esbuild `splitting` so lazy code stays out of the bundle's source string | up to −12 MB heap (upper bound) | first use of each costs 10–60 ms once | low/medium (async factory in the model router) | **#934**: Gateway 128 → 92 MB (providers, MCP SDK, splitting; grammy and turndown left) |
| 6 | Lazy routes in the main renderer (8 MB entry) | est. −10 MB per window, faster first paint | a route's first open loads its chunk (tens of ms) | low | do after 3 |
| 7 | Regression guard: settled idle Gateway footprint and heap, and bundle size, with budgets | protects the above | none | none | **#932**, budgets tightened after #934 |

Refuted or deferred, with reasons:

- **V8 old-space cap**: no idle saving (129 MB with `--max-old-space-size=96`). It is only worth
  having as a ceiling for runaway growth; the guard in item 7 watches growth instead.
- **SQLite `cache_size` / `mmap_size`**: about 1.6 MB of page cache at idle, nothing to win.
- **Bounded in-memory caches and virtualized long lists (transcript, search, Feed)**: they do not
  show in an idle or one-turn profile. They need a long-session profile (hundreds of messages, a
  full Feed) before anything changes. Deferred to a measured follow-up.
- **Freezing background tabs** (`Page.setWebLifecycleState`): it saves CPU, not memory. Discarding
  them (item 4) is the memory lever.

Storage items (none costs RAM):

| # | Change | Saving | Trade-off | Risk |
|---|---|---|---|---|
| S1 | `strip` the helper binary before signing (Swift `-Xlinker -dead_strip`, `strip -x` or full) | −16 MB (`strip -x`) to −20 MB (full) of the helper's 30 MB | crash logs need the dSYM, kept as a build artifact | low |
| S2 | One UI copy: the web client becomes a third entry (`web.html`) of the desktop renderer build, and the packaged Gateway serves it from `app.asar` instead of its own `apps/web/dist` (the other direction would move the renderer out of the asar's integrity check) | ≈ −30 MB (the two 31 MB asset folders share only 1 MB byte for byte, but they are the same modules) | none | **done**: the files stay in `app.asar`; the Gateway checks the header against `ElectronAsarIntegrity` and each file against its SHA-256 before serving |
| S3 | DMG as ULMO (LZMA) instead of ULFO | measured on today's app: 172 → 130 MB (−24%) | copying the app out of the DMG at install 0.7 → 3.9 s, once; mounting unchanged (0.13 s); `make-dmg.sh` 8 → 62 s | low; owner approved; **done** (`PSYCHE_DMG_FORMAT=ULFO` switches back) |
| S4 | Drop `libvk_swiftshader.dylib` | −16.6 MB | none: tested on Electron 44 with the library removed (GPU on: same feature status, WebGL and WebGPU; `--disable-gpu`: software compositing paints, WebGL off as in the stock build, since Chromium only falls back to SwiftShader with `--enable-unsafe-swiftshader`) | low; **done** |
| S5 | Trimmed ICU data | – | – | **refuted**: the browser pane renders arbitrary sites, and `icudtl.dat` sits inside the signed Electron framework |
| S6 | Grammar and locale trimming in the UI chunks | part of S2's 31 MB | rarely used languages highlight as plain text | low; after S2 |

### Test plans

- **2 (renderer release):** a vitest for the window lifecycle (release after the delay, recreate
  on activate/tray/deep link/notification, nothing released while a run streams or the composer
  holds a draft). By hand: close to the tray, wait out the delay, reopen, and check that the
  thread, scroll position and draft come back. Measure the reopen time with `PSYCHE_PERF_HOLD`.
- **3 (lean panel):** the screen-ask and HUD tests in `apps/desktop` and `apps/web`. Then the
  panel's footprint and its cold create-to-ready time before and after (`sample.sh`, `panel.js`).
- **4 (tab discard):** browser-host unit tests: an agent-controlled tab, a taken-over tab and the
  active tab are never discarded; a discarded tab restores its URL.
- **5 (lazy Gateway):** model-router factory tests, MCP host tests, channel tests, then the guard
  (item 7) before and after, with the bundle built.
- **7 (guard):** runs in CI after the Gateway bundle build; fails above budget.

## Phase C: results

| PR | Change | Before → after |
|---|---|---|
| #929 | esbuild Gateway bundle | Gateway settled idle 152 → 127 MB footprint, heap 58 → 31 MB |
| #931 | `strip` the helper before signing (dSYM kept outside the app) | `psyche-helper` 31.1 → 10.6 MB on disk; RAM unchanged |
| #932 | `deploy/scripts/memory-budget.mjs`, budgets in `deploy/size-budget.json`, `PSYCHE_PERF_HOLD` | guard only |
| #933 | Lean renderer entry for the screen-ask panel, region overlay and dictation HUD | warm panel 72 → 54 MB footprint, heap 24 → 16 MB, static JS 8.2 → 4.4 MiB |
| #934 | AI SDK providers and the MCP SDK loaded on first use; esbuild code splitting | Gateway 128 → 92 MB footprint, heap 31 → 25 MB; first chat turn +9 ms once |
| #936 | SwiftShader removed before signing (`src/packaging/swiftshader.ts`) | Electron Framework −16.6 MB on disk; RAM unchanged |
| #937 | One UI copy: the web client is a third entry of the desktop renderer build, served by the packaged Gateway from `app.asar` (header and per-file integrity checked) | `Resources/psyched` 196 → 164 MiB; renderer build +28 KB; RAM unchanged |
| #938 | DMG compressed with LZMA (ULMO) | DMG 172 → 130 MB; install copy +3.2 s once; budget `dmgMB` 210 → 150 |
| (this PR) | Idle background browser tabs discarded after 15 min | −51 MB for a discarded Wikipedia tab; restore ≈ 1 s on activation |

Measured by the guard on the packaged tree (`build-psyched.mjs`, the bundle's own Node) after #934:
**91 MB footprint, 26 MB heap, 5.6 MiB of bundle JS** (entry plus chunks). The budgets are now 105 /
30 / 6.5.

Where #934's saving came from: code splitting alone takes the Gateway from 128 to 118 MB (lazy code
that was already behind `import()`, such as the browser driver and document extraction, leaves the
resident source string; heap goes up 2 MB from per-chunk overhead). The new lazy boundaries take it
from 118 to 92 MB.

What #934 left, with the reason:

- **grammy** (Telegram, ≤ 3.3 MB). `composeChannels` is a synchronous compose part, and
  `ChannelAdapter.capabilities()` and `onInbound()` are synchronous too, so a lazy Telegram needs
  either an async part or a wrapper adapter that buffers handlers. The SMS and Discord adapters also
  import helpers (`readCapped`, approval constants) from `telegram/adapter.ts`, and those would move
  to a shared module first.
- **turndown** (≤ 1.8 MB). It sits behind the synchronous `htmlToMarkdown`, which Google mail MIME
  parsing calls from synchronous code.

Still open, by measured size:

- **Item 2**, releasing the main renderer in the menu bar (−90 to −200 MB). It waits on the owner
  because reopening then takes about 0.5 s.
- **The panel's shared chunk.** `ScreenAsk` reaches most of `@psyche/ui` through the store,
  `GatewayProvider` and the i18n catalog. Splitting those per namespace would bring the warm panel
  from 54 MB toward an empty renderer's 19 MB, and would also shrink the main window's 8 MB entry
  (item 6).
