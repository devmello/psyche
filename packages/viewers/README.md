# @psyche/viewers

**Owner:** S13. Features: P1 (PDF), P3 (sheets), P4 (documents, slides, images, code, JSON, email),
P5 (Markdown editor), P6 (artifact runtime), P9 (text extraction); M2: P2, P8, Univer sheet
editing, Sandpack React artifacts.

In-app viewers, the Markdown editor, the artifact sandbox and text extraction for the agent's file
tools. Plan: [docs/plans/s13.md](../../docs/plans/s13.md). Status: [docs/status/s13.md](../../docs/status/s13.md).

## Entry points

| Import | Contents | Runs in |
| --- | --- | --- |
| `@psyche/viewers` | React components + everything in `core` | renderer (desktop, web) |
| `@psyche/viewers/core` | registry, detection, `extractText`, PDF/sheet/DOCX/email parsing, conversion, artifact sandbox builders, Markdown session, form fill (P2), file generators (P8) | Gateway (Node) and renderer; no React |
| `@psyche/viewers/core/detect`, `@psyche/viewers/core/convert` | MIME detection; the `ConversionService` types and LibreOffice / Quick Look argv builders, without the DOM-typed parsers | Gateway (Node), which compiles without DOM types |
| `@psyche/viewers/bundler` | `reactBundlerResponse(path, { appOrigin, bundlerOrigin })`: the self-hosted React artifact bundler's files (page, runtime, vendored React 19, Babel standalone) | Gateway only (Node: reads `node_modules`) |
| `@psyche/viewers/styles.css` | structural styles (`psy-*` classes, theme via `--psy-*` variables) | renderer |

## Registry contract (protocol `ViewerRegistry`)

`createDefaultViewerRegistry()` returns a `DefaultViewerRegistry` loaded with the built-in specs
(`DEFAULT_VIEWER_SPECS`). Resolution: exact MIME → `type/*` → extension; ties by higher `priority`,
then registration order. Contract tests run against both this registry and `FakeViewerRegistry`
(`test/registry.test.ts`). HTML files resolve to the **code** viewer: they are never rendered live
outside the artifact sandbox. `detectMime({ name, mime, bytes })` sniffs magic bytes first, so a
`.pdf` that is really HTML is demoted to `application/octet-stream`.

Every viewer takes `ViewerProps` (`src/react/contract.ts`):

```ts
interface ViewerProps {
  item: ViewerItem;                         // id, name, mime, provenance, etag?, libraryItem?
  load(signal: AbortSignal): Promise<Uint8Array>; // the host fetches bytes; viewers never pick URLs
  pageState?: PageState;                    // page, zoom, sheet, line
  onPageStateChange?(s: PageState): void;
  onSelectionChange?(s: ViewerSelection | null): void; // text, cells, lines, field
  onOpenInPane?(r: { pane; target }): void; // links → browser pane, Edit → editor pane
  onSendToChat?(p: SendToChatPayload): void;
  onSaveToLibrary?(f: { name; mime; bytes }): void; // exports, filled PDF copies, attachments
  conversion?: ConversionService;           // slides
  compact?: boolean;                        // inline chat cards
}
```

`<ViewerHost item load … registry? components? artifactHostUrl? onTrust? />` resolves the viewer,
lazy-loads it (one chunk per viewer), wraps it in an error boundary and gates quarantined downloads behind an
explicit Open (per item).
Shells override a render kind with `components={{ pdf: MyPdf }}`.

## Viewers

| Kind | Component | Library | Notes |
| --- | --- | --- | --- |
| pdf | `PdfViewer` | PDF.js 6.4 (self-hosted worker) | virtualized pages, text layer, search, outline, zoom/fit, AcroForm field outlines + side list + fill preview (`proposedValues` marks agent values), explicit **XFA not supported** state, export, print; document JS never runs |
| sheet | `SheetViewer` | SheetJS CE 0.20.3 (vendor tarball), TanStack Table 9 + Virtual | tabs, filters (`>100`, `=Rent`, `empty`, text), column stats, CSV/TSV via our parser; 50k rows < 2 s; **Edit** (below) when the host passes `onSave` |
| sheet (edit) | `SheetEditor` | Univer 1.0.3 (Apache-2.0), lazily loaded | see "Spreadsheet editing" |
| document | `DocumentViewer` | docx-preview, mammoth | Layout / Text toggle; sanitized and shown in the sandbox frame (scripts off); falls back to mammoth |
| slides | `SlidesViewer` | `ConversionService` | converted PDF → PDF viewer, or a Quick Look thumbnail, else a placeholder with each slide's text |
| image / media | `ImageViewer` / `MediaViewer` | native | always `<img>` (SVG included), fit / 100 % / zoom |
| code / text / markdown | `CodeViewer` | CodeMirror 6 read-only + Shiki 4 (JS regex engine, lazy grammars) | line numbers, search, "Send to chat" with line selection |
| json | `JsonViewer` | — | collapsible tree, paged arrays, JSON Lines, Raw toggle |
| email | `EmailViewer` | postal-mime, DOMPurify | headers, attachments, sanitized HTML in the sandbox, remote images blocked until "Load remote images", marked untrusted |
| artifact | `ArtifactViewer` / `ArtifactFrame` | — | see below |

## Spreadsheet editing

`SheetViewer` shows **Edit** when the host passes `onSave(file)` and the file is xlsx, xls, ods,
csv or tsv (not xlsm: SheetJS CE would drop the macros). Edit swaps the grid for `SheetEditor`:
Univer's sheets UI (formulas, number formats, merges, sizing, undo) over a snapshot that
`toUniverSnapshot` built with SheetJS CE, because xlsx import/export is a Univer Pro feature.
**Save** is explicit; `fromUniverSnapshot` writes the edited snapshot back to the file's own format
and `onSave` receives `{ name, mime, bytes }`. Kept: values and types, formulas with Univer's
recalculated results (filled or pasted formulas are resolved per cell before saving), number
formats, merges, column widths, row heights, hidden rows, columns and sheets, sheet names and
order; carried around Univer: defined names (formulas using them show `#NAME?` in the editor but
keep working in the file) and the 1904 date system. Not kept (a note says which apply before
saving): fonts, fills, borders, comments, images, hyperlinks; array formulas become ordinary
formulas. CSV/TSV keep their delimiter, BOM, line endings and final newline, never reformat
numbers (`007`, `1.50`, 19-digit ids stay as written), and write the first sheet's values. Sheets
over 2M cells stay read-only. Opening a file is not an edit (formula recalculation and view
changes do not mark it dirty). **Done** asks before discarding unsaved edits; the grid re-reads
the file afterwards.

Univer (≈ 7 MB minified, 1.8 MB gzip, plus 116 KB CSS) is only imported when Edit is pressed
(`react/univer.ts`); formulas run on the main thread, so no worker origin is needed, and it makes
no network request (its telemetry package is an interface only). The editor glue in the sheet
chunk is ≈ 5 KB gzip. Tests: `sheet-edit.test.ts` (bridge round trips), `SheetEditor.test.tsx`
(fake runtime), `univer.browser.test.ts` (real Univer in Chrome under a strict CSP: a typed edit
recalculates a formula and saves back to xlsx, no external request).

## Markdown editor

`<MarkdownEditor path store autosaveMs? initialMode? proposed? remote? readOnly? onSaved? />`.
CodeMirror 6 in all modes (decision memo: [docs/editor-decision.md](docs/editor-decision.md)).
Rich = live-preview decorations, Source = plain, Diff = unified merge view against the last save or
the agent's `proposed` edit. A `DocumentStore` (`load`, `save(content, baseEtag)`) is the only I/O;
saves are compare-and-swap, and an edit by someone else surfaces as a conflict (Keep mine / Take
theirs / Compare), never a silent overwrite. Persona files (`SOUL.md`, `IDENTITY.md`, `AGENTS.md`
20k; `USER.md` 4k) get a budget meter and explicit Save; other notes autosave (1.5 s). `IDENTITY.md`
and any file with frontmatter get a YAML panel; the block is preserved byte-for-byte unless edited.

## Artifact sandbox

- `<iframe sandbox="allow-scripts" srcdoc>`; never `allow-same-origin`.
- `buildArtifactSrcdoc(html, policy)` puts a CSP `<meta>` first: `default-src 'none'`,
  `connect-src 'none'`, images/fonts from `data:`/`blob:` only, `form-action 'none'`,
  `base-uri 'none'`, no frames, workers or objects. Email/document mode runs no script except the
  nonce'd bridge.
- Bridge (no iframe-resizer): `resize`, `open-link` (http/https/mailto only, opened in the browser
  pane), `error`, `ready`. The parent checks `event.source`, origin and a per-render channel.
  Artifact script can forge bridge messages, so `open-link` is honoured only while focus is inside
  the frame (the user clicked it) and at most once a second; the bridge itself only reports trusted
  clicks on `a[href]` / `area[href]`.
- Placements: **inline** (srcdoc in the app; inherits the app's CSP) and **hosted**: the Gateway
  serves `artifactHostPage(appOrigin, nonce)` with `artifactHostHeaders(appOrigin)` on a separate
  origin (distinct loopback port or `artifacts.` host); the app frames it and posts the srcdoc.
- A frame that navigates itself is torn down (second `load` inline; `navigated` from the host page).
  The desktop shell must also cancel subframe navigations and restrict WebRTC (see status): CSP
  covers neither self-navigation nor STUN/TURN or DNS prefetch.
- Update by name: `upsertArtifact(existing, { title, type })` bumps the version of the same slug.
- Proof: `test/sandbox.browser.test.ts` runs in a local Chrome (playwright-core, no download;
  skipped when Chrome is absent) and shows a hostile artifact cannot read the parent, cookies or
  storage, and that fetch, XHR, WebSocket, EventSource, beacon, images, CSS, `@import`, scripts,
  workers, forms, popups and top navigation never reach another host.

## React artifacts (Sandpack, self-hosted bundler)

`ArtifactViewer` runs items of type `application/vnd.psyche.artifact+react` with
`ReactArtifactFrame` when the host passes `reactBundlerUrl`. Source is one component (rendered
from its default export) or JSON `{"files": {"/App.tsx": "…", "/styles.css": "…"}}`;
`parseReactArtifact` validates paths and size (5 MB).

- The app runs `@codesandbox/sandpack-client` 2.19.8 (Apache-2.0; ≈ 29 KB gzip, lazily loaded),
  which frames the bundler with `sandbox="allow-scripts"`: an opaque origin, like every artifact.
  The client posts to the bundler URL's origin, which an opaque frame never matches, so
  `mountReactArtifact` targets `"*"`. Messages go to that frame's window; if the frame navigated
  elsewhere first they would follow it, which the app's `frame-src` (no other origin can load in
  the frame) and the teardown on a second load prevent. Replies are accepted only from that
  frame's window, and only the first `initialized` is honoured (artifact code cannot make the app
  re-post its files in a loop).
- The bundler is ours and speaks Sandpack's runtime protocol (`initialized`, `register-frame`,
  `compile` → `start`/`status`/`action show-error`/`done`). The Gateway serves it with
  `reactBundlerResponse` on its own loopback origin: `/` (page), `/runtime.js`, `/vendor.js`
  (React 19 production CJS from `node_modules`), `/babel.min.js` (`@babel/standalone` 8.0.6, MIT).
  Imports are limited to `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`; nothing is
  fetched from npm or a CDN. CodeSandbox's own bundler would be protocol-compatible but fetches
  dependencies from its packager CDN, so it is not used.
- `reactBundlerHeaders` is `buildArtifactCsp` with the bundler origin as the only library origin
  plus `'unsafe-eval'` (the bundler evaluates what it transpiles), and `frame-ancestors` the app.
  `connect-src 'none'` blocks every request, to the bundler origin too.
- Bridge: the bundler page carries the artifact bridge with the channel from the URL fragment
  (`resize`, `open-link`, `error`). Any load after the first (the frame navigating itself) tears
  the frame down. A recompile (update by name) unmounts every root made through
  `react-dom/client` first.
- Serve the bundler on a dedicated loopback port that answers only its four paths: its origin is
  in the page's `script-src`, so artifact code can send GETs to it.
- Proof: `test/react-artifact.browser.test.ts` (Chrome): a TypeScript counter compiles and runs;
  a hostile artifact cannot read the parent, cookies, storage or IndexedDB, and fetch (other hosts
  and the bundler origin), XHR, beacon, WebSocket, workers, service workers, images, scripts, CSS,
  forms, popups and top navigation never reach another host; an app CSP with
  `frame-src <bundler origin>` also stops self-navigation (the frame lands on an error page).

## Extraction (P9)

`extractText({ bytes, name, mime?, provenance? }, { cursor?, maxChars?, ocr?, signal? })` →
`{ kind, text, refs[], nextCursor?, total, provenance, warnings }`. PDF pages (`p.12`), sheet rows
(`Sheet1!A2:F2`), slides (`slide 3`), DOCX/email/text by characters. Output is bounded (20k
characters by default) and paged by an opaque cursor; inputs over 200 MB are refused. Text-less PDF
pages and images go to an injected `OcrProvider` (Mac node Vision or Tesseract in the sandbox).
Provenance defaults to `untrusted`.

## Documents pipeline (P2)

Pure functions in `core/forms.ts`; the task engine (S04) orchestrates them with `ask_user`, the
mail connector (S09) and `PermissionBroker` approvals. Nothing here sends, asks or approves.

```ts
detectFormFields(pdf, { ocr?, password?, maxOcrPages? })
  → { kind: "acroform" | "hybrid" | "xfa" | "none" | "scanned", fillable, fields[], unsupported[], sha256, warnings }
prepareFilledCopy({ name, bytes }, detection, values)
  → { name: "x (filled).pdf", bytes, sha256, sourceSha256, review[], skipped[], missingRequired[], applied[] }
finalizeFilledCopy({ name, bytes }, reviewedSha256)   // throws FormFillError("binding_mismatch")
  → { name, bytes (flattened), sha256, reviewedSha256 }
fillReceipt({ sourceName, copy, final, approvalId?, taskId?, toolCallId? }) → ReceiptInput
```

Orchestrator flow for "complete the permission slip":

1. `detectFormFields` on the attachment. `xfa` → tell the user it cannot be filled; `scanned`
   without OCR → ask for a fillable copy. Ask for each `fields[i]` by `label` (`options` become
   choices; `required` fields first). Never ask for `unsupported` ones (signatures, buttons, read-only).
2. `prepareFilledCopy`; re-ask for `missingRequired` and anything in `skipped` (reasons:
   `too_long`, `not_an_option`, `wrong_type`, `unsupported_characters`, `unknown_field`, ...).
3. Show the copy in `PdfViewer` with the `review` rows; the reply draft's `send_email` approval
   binds to the filled copy's `sha256`.
4. On approval, `finalizeFilledCopy(copy, approvedSha)` re-hashes and flattens; attach `final.bytes`.
5. Record `fillReceipt(...)` (kind `file_write`, payload `action: "document.fill"`). It carries
   field names and sha256s, never values.

Filling uses `@cantoo/pdf-lib` with Helvetica: values are validated, never truncated or coerced;
non-WinAnsi text is reported as `unsupported_characters` (embed a Unicode font in a later
iteration). Hybrid XFA forms lose the XFA packet so readers show the AcroForm values. Scanned
forms: `OcrProvider.recognize` may return `lines` with normalised boxes; label lines (`Name: ___`)
become `overlay` fields whose values are drawn as page text.

## Generators (P8)

`generateFile(request)` → `GeneratedFile[]` (`{ name, mime, bytes }`); pure, the Gateway writes
the files through the normal `file_write` path. Every string is untrusted model output and is
escaped for its target.

| `format` | Input | Engine | Notes |
| --- | --- | --- | --- |
| `markdown` | `DocSpec` | own | block syntax and HTML escaped; charts → table + sibling `.svg` |
| `pdf` | `DocSpec` (+ `pageSize`) | `@cantoo/pdf-lib` | wrapped rich text, paginated tables with repeated header, `drawSvg` charts, page numbers; WinAnsi only (others print `?`) |
| `docx` | `DocSpec` | `docx` | headings, rich runs, lists, tables; charts as caption + data table |
| `html` | `DocSpec` | own | standalone page with `default-src 'none'` CSP; print with Chromium for full Unicode |
| `xlsx` | `WorkbookSpec` | SheetJS CE | strings never become formulas (`{ formula }` is explicit), number formats, autofilter, widths |
| `pptx` | `DeckSpec` | pptxgenjs | cover slide, bullets, tables, native bar/line/pie charts, notes |
| `svg` | `ChartSpec` | own | static bar/line/pie, no scripts or external refs |
| `itinerary` / `dashboard` | `ItinerarySpec` / `DashboardSpec` | own | script-free templates; `templateArtifact(html)` wraps them in the artifact srcdoc |

`DocSpec.blocks`: `heading`, `paragraph` (inline `**bold**`, `*italic*`, `` `code` ``), `list`,
`table`, `code`, `quote`, `chart`, `pageBreak`. `GENERATOR_LIMITS` bounds blocks, rows, sheets,
slides and chart points.

## Conversion service

```ts
interface ConversionService {
  id: string;
  supports(input: { name; mime }, target: "pdf" | "thumbnail"): boolean;
  convert(input: { bytes; name; mime }, target, opts?: { signal }): Promise<
    { kind: "pdf"; bytes } | { kind: "thumbnail"; mime: "image/png"; bytes }>;
}
```

Implementations: `GotenbergConversionService({ baseUrl })` (`POST /forms/libreoffice/convert`),
`SandboxLibreOfficeService({ runner, sandboxId, files, workspacePath })` (`soffice --headless` in
the task sandbox through `SandboxRunner`; never on the host), `ChainedConversionService`. Argv
builders `libreOfficeArgv` and `qlmanageArgv` are exported for the Mac node. File names are reduced
to safe basenames before reaching argv or paths.

## Shell setup

```ts
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { configurePdfJs } from "@psyche/viewers";
import "@psyche/viewers/styles.css";
configurePdfJs({ workerSrc, standardFontDataUrl: "/pdfjs/standard_fonts/", cMapUrl: "/pdfjs/cmaps/" });
```

The app CSP needs `frame-src` for the artifacts origin and the React bundler origin (and nothing
else: that also stops artifact frames from navigating themselves). The Univer editor was tested
under `script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; worker-src 'none'`.

## Licenses

All runtime dependencies are permissive: pdfjs-dist (Apache-2.0), SheetJS CE `xlsx` 0.20.3 from
`cdn.sheetjs.com` (Apache-2.0; npm `xlsx` 0.18.5 is excluded by ADR-013), TanStack Table/Virtual
(MIT), docx-preview (Apache-2.0), mammoth (BSD-2-Clause), jszip (MIT option of MIT/GPL dual),
@cantoo/pdf-lib (MIT), docx (MIT), pptxgenjs (MIT), Univer 1.0.3 (`@univerjs/*`, Apache-2.0; its
transitive tree is MIT/Apache/BSD/ISC; `protobufjs` comes in through `@univerjs/protocol` and its
install script is disabled), rxjs (Apache-2.0), @codesandbox/sandpack-client (Apache-2.0),
@babel/standalone (MIT), React/react-dom (MIT),
DOMPurify (Apache-2.0 option of MPL/Apache dual), postal-mime (MIT-0), CodeMirror 6 (MIT), Shiki
(MIT), yaml (ISC). Excluded per ADR-013: iframe-resizer, Handsontable/HyperFormula, BlockNote XL,
ONLYOFFICE, Monaco.

## Stubbed / not yet

- OCR and Office conversion run only when the Gateway injects an `OcrProvider` / `ConversionService`.
- The React bundler origin is served by the Gateway (S01) with `reactBundlerResponse`; the app
  passes its URL as `reactBundlerUrl`. React artifacts can import React and react-dom only.
- Univer runs without its xlsx/Pro plugins, so cell styling, charts, pivots, comments and images
  are not editable or saved.
- P2 orchestration (ask_user, reply draft, approval, send) is S04/S09; OCR overlays need an
  `OcrProvider` that returns line boxes. Non-Latin form values need an embedded Unicode font.
- The PDF generator uses the standard fonts (WinAnsi); Chromium print of `docToHtml` is the
  full-Unicode path. DOCX charts are tables (SVG images need a PNG fallback we cannot rasterise).
- The artifacts origin itself is served by the Gateway (S01); this package ships the page and headers.
