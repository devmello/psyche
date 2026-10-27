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
