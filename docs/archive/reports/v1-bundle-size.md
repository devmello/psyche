# Psyche.app bundle size (v1.0)

**Owner:** S22. **Measured:** 2026-10-20 on darwin-arm64 from `main` at `0be47c59`.

**How it was built:**
- `node deploy/scripts/build-psyched.mjs --smoke`
- `deploy/macos/build-helper.sh --arch arm64`
- `pnpm --filter @psyche/desktop run package --arch=arm64`

That is one build each. The packaged app was never launched, and no DMG was built or mounted.

**Units:**
- Sizes are `du -sk` on disk, in MiB.
- "Compressed" is an LZFSE archive of the same files (`aa archive -a lzfse`), the codec of the ULFO DMG that `make-dmg.sh` writes. It stands in for the DMG size.

## Summary

| | On disk | Compressed (≈ DMG) | Target |
| --- | ---: | ---: | ---: |
| **Psyche.app** | **1472 MB** | **370 MB** | **< 250 MB, ideally < 200 MB** |
| `Resources/psyched/` (Gateway bundle) | 1035 MB | 217 MB | ≤ 75 MB |
| `Frameworks/Electron Framework.framework` | 286 MB | 119 MB | ≤ 108 MB |
| `Resources/app.asar` | 106 MB | 25 MB | ≤ 8 MB |
| `Resources/PsycheHelper.app` | 17 MB | ≈ 5 MB | as is |
| everything else | ≈ 28 MB | ≈ 4 MB | as is |

The 733 MB the owner saw for the first DMG install does not match these numbers; it is probably the earlier build or Finder's figure. All before/after comparisons in the size work use the method above.

## Resources/psyched (1035 MB)

| Part | On disk | Compressed | Notes |
| --- | ---: | ---: | --- |
| `runtime/node` | 128 MB | 36 MB | Only `bin/node` ships (no npm, corepack or headers). `strip -x` takes it to 98 MB (33 MB compressed) and it still runs after re-signing; osx-sign re-signs it anyway |
| `app/node_modules` | 809 MB | 151 MB | 604 packages. **At boot psyched loads 77 of them (124 MB)**, traced with a `module.registerHooks` resolve hook from `/healthz` up |
| `app/apps/web/dist` | 83 MB | 18 MB | **60 MB of it is sourcemaps** |
| `app/packages/*`, `app/apps/gateway`, … | ≈ 15 MB | small | Includes packages the Gateway never loads (`packages/ui` 13 MB of source, `packages/testing`) |

### The largest packages in `app/node_modules` and why they are there

The Gateway imports two tiny pure modules from `@psyche/viewers`: `core/convert` (`libreOfficeArgv`) and `core/detect` (`mimeFromName`). Because `@psyche/gateway` depends on the whole package, pnpm installs every viewer dependency: Univer, Sandpack, CodeMirror, React, docx, pdf-lib and the `@psyche/ui` stack. None of them is loaded at boot.

| Package | MB | Pulled in by | Needed by psyched |
| --- | ---: | --- | --- |
| @codesandbox/sandpack-client | 65.2 | viewers | no |
| lucide-react | 45.6 | viewers → ui | no |
| @univerjs/engine-formula | 41.8 | viewers | no |
| pdfjs-dist | 34.9 | files, viewers | `@psyche/files` text extraction (lazy) |
| @cantoo/pdf-lib | 31.2 | viewers | no |
| @univerjs/engine-render | 28.2 | viewers | no |
| @napi-rs/canvas-darwin-arm64 | 26.8 | pdfjs-dist (optional) | no (text extraction does not render) |
| @univerjs/ui | 24.8 | viewers | no |
| @base-ui/react | 19.7 | ui | no |
| docx | 19.2 | viewers | no |
| happy-dom | 17.5 | viewers | no |
| drizzle-orm | 16.5 | db | yes |
| @rolldown/binding-darwin-arm64 | 16.3 | viewers (bundler) | no |
| colorjs.io | 16.2 | ui | no |
| better-sqlite3-multiple-ciphers | 15.6 | vault | yes |
| playwright-core | 13.3 | browser | yes; loaded at boot even with the browser off (static import in `drivers/playwright.ts`, a startup item for PR 3) |
| @assistant-ui/core | 13.2 | ui | no |
| better-sqlite3 | 12.1 | db | yes |
| rxjs | 11.1 | Univer | no |
| @shikijs/langs | 10.5 | viewers, ui | no |
| esbuild + @esbuild/darwin-arm64 | 20.3 | viewers (bundler) | no |
| ai | 9.5 | model-router | yes |
| lightningcss-darwin-arm64 | 8.2 | viewers (bundler) | no |
| zod | 8.1 | model-router | yes |
| react-dom | 7.8 | viewers | no |
| xlsx | 7.8 | viewers | no |
| jsdom | 6.9 | viewers | no |
| @modelcontextprotocol/client | 6.8 | mcp-host | yes |

The boot set is 124 MB, covering:
- AI SDK providers;
- grammy;
- MCP client;
- simplewebauthn and its `@peculiar` ASN.1 tree;
- better-sqlite3 (both builds), drizzle;
- playwright-core, turndown/domino;
- age-encryption, typebox, zod, ws, yaml, cron-parser, fflate.

Add the packages loaded later (pdfjs-dist for file text, and the providers that a model call loads), and psyched needs roughly 170 MB of `node_modules` on disk.

## Electron Framework (286 MB)

| Part | MB | Notes |
| --- | ---: | --- |
| `Electron Framework` binary | 193 | fixed |
| `Resources/*.lproj` | **48.8** | 110 Chromium locales. The UI is English only; `en.lproj` is 0.6 MB |
| `Resources/resources.pak`, `icudtl.dat` | 22 | fixed |
| `Libraries` (ANGLE, SwiftShader) | 18 | keep: WebGL and GPU fallback |

## app.asar (106 MB)

| Part | MB | Notes |
| --- | ---: | --- |
| `.vite/build` sourcemaps | **59.1** | `sourcemap: true` in `vite.main.config.ts` and `vite.preload.config.ts` |
| `.vite/build` code | **23.3** | the main process bundles **all of `@psyche/viewers`** (Univer, Shiki grammars, pdf.js, docx, xlsx, a development `react-dom`) |
| `.vite/renderer` | 23.4 | the renderer (the web client) |
| node-pty | 0.2 | unpacked `.node` and `spawn-helper` |

The main-process bloat has one cause.
- `apps/desktop/src/lib/zoom.ts` imports five zoom helpers from the `@psyche/web/compose` barrel.
- That barrel re-exports `compose/viewers.tsx` and `compose/backups.tsx`.
- So Rollup keeps every viewer chunk reachable from main.
- Importing the zoom module directly drops about 20 MB of code and its maps.

## Targets and the cuts that reach them (PR 2)

| Cut | Saves (compressed) | Where |
| --- | ---: | --- |
| Install psyched without `@psyche/viewers`' dependency tree: the Gateway's subset keeps only `viewers/src/core/{convert,detect,registry}`. Verify that every shipped import resolves, then smoke | ≈ 110 MB | `build-psyched.mjs` |
| Copy only the workspace packages in the Gateway and CLI closure; drop `packages/ui`, `packages/testing`, root configs, `skills/`, tests and `*.md` inside `node_modules` | ≈ 3 MB | `build-psyched.mjs` |
| Drop `*.map` from `apps/web/dist` in psyched (keep them as a release artifact) | ≈ 13 MB | `build-psyched.mjs` |
| Drop the optional `@napi-rs/canvas` (pdf.js text extraction does not render) | ≈ 8 MB | `build-psyched.mjs` |
| `strip -x` the Node runtime after the SHA-256 check | ≈ 4 MB | `build-psyched.mjs` |
| Ship only `en.lproj` (and `Base.lproj`) of Electron's locales; document it | ≈ 12 MB | `forge.config.ts` hook |
| No sourcemaps in the packaged main and preload bundles | ≈ 12 MB | `vite.main.config.ts`, `vite.preload.config.ts` |
| Main process imports the zoom helpers directly, not through the `@psyche/web/compose` barrel | ≈ 5 MB | `apps/desktop/src/lib/zoom.ts` (+ one `exports` entry in `apps/web/package.json`) |
| **Projected** | **370 → ≈ 200 MB** | |

Heavy optional features need no bundled dependency or stay lazy:
- LibreOffice conversion runs LibreOffice in the full sandbox image (`compose/convert.ts`).
- Univer and Sandpack belong to the renderer only.
- pdf.js is a dynamic import in `packages/files/src/extract/pdf.ts`.
- Making playwright-core lazy when the browser is off is a startup item (PR 3).

The cut is checked by:
- `build-psyched --smoke`;
- `apps/gateway/test/dist-bin.test.ts`;
- the boot trace above, extended to a file-extraction call.

## After the cut (PR 2)

Measured the same way, from the same commit plus the cut: psyched rebuilt with `--smoke`, then one `electron-forge package`.

| | Before (disk) | After (disk) | Before (compressed) | After (compressed) |
| --- | ---: | ---: | ---: | ---: |
| **Psyche.app** | 1472 MB | **531 MB** | 370 MB | **183 MB** |
| `Resources/psyched/` | 1035 MB | 247 MB | 217 MB | 65 MB |
|   `runtime/node` | 128 MB | 93 MB | 36 MB | 33 MB |
|   `app/node_modules` | 809 MB (604 pkgs) | 117 MB (96 pkgs) | 151 MB | ≈ 25 MB |
|   `app/apps/web/dist` | 83 MB | 24 MB | 18 MB | ≈ 6 MB |
| `Electron Framework.framework` | 286 MB | 238 MB | 119 MB | 106 MB |
| `Resources/app.asar` | 106 MB | 24 MB | 25 MB | 6 MB |
|   `.vite/build/main.cjs` | 3.8 MB + 23 MB of chunks + 59 MB maps | 0.3 MB | | |
| `Resources/PsycheHelper.app` | 17 MB | 17 MB | 3.5 MB | 3.5 MB |

**The target is met: ≈ 183 MB, under 200 MB.**

**Checks on the result**
- `build-psyched --smoke` is healthy with only `PSYCHE_HOME` set.
- `apps/gateway/test/dist-bin.test.ts` passes.
- The bundled `psyche` CLI runs.
- PDF text extraction works on the rebuilt bundle. pdf.js prints two warnings about `DOMMatrix`/`Path2D` polyfills when it first loads, harmless without rendering.
- `codesign --verify --deep --strict` passes on the packaged app.
- The build fails if any bare import in the shipped sources (lazy `import()` included) no longer resolves.

**Not run:** the packaged app itself (the owner's Mac runs the first DMG install, so it is not launched here), and an x64 build.

**What is left, and why it stays:**
- **`.vite/renderer` (23 MB on disk):** the web client with its viewers, which the renderer does load. Code-splitting the viewers is S11/S13 work.
- **The Electron binary (193 MB):** fixed.
- **`resources.pak` and `icudtl.dat`:** fixed.
- **ANGLE/SwiftShader:** kept for WebGL and the GPU fallback.

## Reproduce

```sh
node deploy/scripts/build-psyched.mjs --smoke
deploy/macos/build-helper.sh --arch arm64
pnpm --filter @psyche/desktop run package --arch=arm64
du -sk apps/desktop/out/Psyche-darwin-arm64/Psyche.app/Contents/{Frameworks,Resources}/*
aa archive -d apps/desktop/out/Psyche-darwin-arm64 -o /tmp/psyche.aar -a lzfse && ls -l /tmp/psyche.aar
```
