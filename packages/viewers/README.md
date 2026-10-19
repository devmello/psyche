# @psyche/viewers

**Owner:** S13. Features: P1 (PDF), P3 (sheets), P4 (documents, slides, images, code, JSON, email),
P5 (Markdown editor), P6 (artifact runtime), P9 (text extraction); M2: P2, P8.

In-app viewers, the Markdown editor, the artifact sandbox and text extraction for the agent's file
tools. Plan: [docs/plans/s13.md](../../docs/plans/s13.md). Status: [docs/status/s13.md](../../docs/status/s13.md).

## Entry points

| Import | Contents | Runs in |
| --- | --- | --- |
| `@psyche/viewers` | React components + everything in `core` | renderer (desktop, web) |
| `@psyche/viewers/core` | registry, detection, `extractText`, PDF/sheet/DOCX/email parsing, conversion, artifact sandbox builders, Markdown session, form fill (P2), file generators (P8) | Gateway (Node) and renderer; no React |
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
| sheet | `SheetViewer` | SheetJS CE 0.20.3 (vendor tarball), TanStack Table 9 + Virtual | tabs, filters (`>100`, `=Rent`, `empty`, text), column stats, CSV/TSV via our parser; 50k rows < 2 s |
| document | `DocumentViewer` | docx-preview, mammoth | Layout / Text toggle; sanitized and shown in the sandbox frame (scripts off); falls back to mammoth |
| slides | `SlidesViewer` | `ConversionService` | converted PDF → PDF viewer, or a Quick Look thumbnail, else a placeholder with each slide's text |
| image / media | `ImageViewer` / `MediaViewer` | native | always `<img>` (SVG included), fit / 100 % / zoom |
| code / text / markdown | `CodeViewer` | CodeMirror 6 read-only + Shiki 4 (JS regex engine, lazy grammars) | line numbers, search, "Send to chat" with line selection |
| json | `JsonViewer` | — | collapsible tree, paged arrays, JSON Lines, Raw toggle |
| email | `EmailViewer` | postal-mime, DOMPurify | headers, attachments, sanitized HTML in the sandbox, remote images blocked until "Load remote images", marked untrusted |
| artifact | `ArtifactViewer` / `ArtifactFrame` | — | see below |

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

## Licenses

All runtime dependencies are permissive: pdfjs-dist (Apache-2.0), SheetJS CE `xlsx` 0.20.3 from
`cdn.sheetjs.com` (Apache-2.0; npm `xlsx` 0.18.5 is excluded by ADR-013), TanStack Table/Virtual
(MIT), docx-preview (Apache-2.0), mammoth (BSD-2-Clause), jszip (MIT option of MIT/GPL dual),
@cantoo/pdf-lib (MIT), docx (MIT), pptxgenjs (MIT),
DOMPurify (Apache-2.0 option of MPL/Apache dual), postal-mime (MIT-0), CodeMirror 6 (MIT), Shiki
(MIT), yaml (ISC). Excluded per ADR-013: iframe-resizer, Handsontable/HyperFormula, BlockNote XL,
ONLYOFFICE, Monaco.

## Stubbed / not yet

- OCR and Office conversion run only when the Gateway injects an `OcrProvider` / `ConversionService`.
- Univer spreadsheet editing and Sandpack React artifacts (M2) are not started.
- P2 orchestration (ask_user, reply draft, approval, send) is S04/S09; OCR overlays need an
  `OcrProvider` that returns line boxes. Non-Latin form values need an embedded Unicode font.
- The PDF generator uses the standard fonts (WinAnsi); Chromium print of `docToHtml` is the
  full-Unicode path. DOCX charts are tables (SVG images need a PNG fallback we cannot rasterise).
- The artifacts origin itself is served by the Gateway (S01); this package ships the page and headers.
