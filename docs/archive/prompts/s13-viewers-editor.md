# Session S13 — Viewers, editor and documents

You are building Psyche (read `README.md`). You are session **S13 — Viewers, editor, documents**: `packages/viewers`, the in-app PDF, spreadsheet, DOCX/PPTX, image, code and email viewers, the Markdown editor, the artifact sandbox frame, text extraction for the agent, and (M2) the Documents pipeline and file generators. Work in your own worktree on branch `ws/s13-viewers-editor`. You own `packages/viewers/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §5 (viewers), §4.12 (Library)
3. `docs/06-ui-design.md` sections on files/viewers, the Markdown editor and artifacts
4. `docs/03-feature-spec.md` rows P1–P9
5. `docs/07-tech-decisions.md` ADR-013 (library choices and exclusions on license grounds)
6. `docs/05-security-and-permissions.md` (artifact sandboxing rules)
7. Protocol types for LibraryItem/Artifact; `packages/ui` placeholder slots
8. Research: `models_memory_mcp_ui_feed.md` "Editors & viewers" (MDXEditor, TipTap, BlockNote license, SheetJS CE install source and the npm `xlsx` advisory, Univer, PDF.js 6, EmbedPDF, docx-preview/mammoth, Gotenberg/`qlmanage`, Shiki 4, Streamdown, sandboxed iframe rules, Sandpack); `shopping_messaging_server_docs.md` KQ5 (AcroForm vs XFA detection, pdf-lib/PyMuPDF/pdftk/PDFKit filling and flattening, Apple Vision OCR)

## Mission (M1)
- **Viewer registry**: components registered by MIME type / extension with a common props contract (item, page state, selection events, "open in pane" and "send to chat" hooks) consumed by `packages/ui` and the shells.
- **PDF**: PDF.js 6 with a self-hosted worker; paging, zoom, search, text selection, outline; AcroForm field highlights and values; `isPureXfa` detection with a clear "XFA not supported" state; print/export.
- **Spreadsheets**: SheetJS CE installed from the vendor tarball (never npm `xlsx`), sheet tabs, TanStack Table virtualized grid, filters, column stats, CSV/TSV; 50k-row CSV under 2 s.
- **Documents and slides**: DOCX via docx-preview (fallback mammoth → HTML); PPTX via a conversion service interface (LibreOffice headless / Gotenberg in the sandbox, or `qlmanage` thumbnails on the Mac node) with a graceful placeholder; images with zoom; JSON tree; code with CodeMirror 6 read-only + Shiki 4 highlighting; email preview (sanitized HTML, remote images blocked by default, attachments list).
- **Markdown editor**: rich / source / diff modes (MDXEditor if it meets the bar, else CodeMirror 6 + a WYSIWYG view); autosave; etag conflict detection when the agent edits the same file; used for notes, memory files, artifacts and Library docs; frontmatter-aware for `IDENTITY.md`.
- **Artifact frame**: `sandbox="allow-scripts"` srcdoc iframe on a separate origin (served by the Gateway at an `artifacts.` subdomain or distinct port) with a strict CSP; a home-grown resize/postMessage bridge (no iframe-resizer); update-by-name; "open in browser pane" and "save to Library" hooks; React artifacts via self-hosted Sandpack bundler (M2).
- **Extraction for the agent** (P9): `extractText(item)` for PDF (page refs), DOCX, XLSX (sheet/cell refs), CSV, images (OCR hook via the Mac node's Vision capability or Tesseract in the sandbox), bounded output with "more" paging.

## Out of scope
Screens that host viewers (S12), Library storage (Gateway), the Documents pipeline orchestration (M2 below, done with S04's task engine), file generators until M2.

## Definition of done
- Component tests per viewer with fixtures (a 100-page PDF, a fillable AcroForm, an XFA sample, a 50k-row CSV, DOCX/PPTX samples, a malicious HTML email); performance budgets; sandbox tests proving the artifact frame cannot reach the parent origin or fetch external hosts; editor round-trip tests (Markdown in → edit → Markdown out without loss on common constructs); extraction tests.
- README: registry contract, license notes, conversion service interface; `docs/status/s13.md`.

## Suggested subagents
One for PDF.js + forms, one for sheets, one for the editor evaluation (MDXEditor vs CodeMirror+WYSIWYG, with a decision memo), one for the artifact sandbox security tests.

## M2 follow-ons
P2 Documents pipeline (import → detect fields → `ask_user` values → fill with pdf-lib → preview → reviewed reply via the mail connector → flatten → receipt; OCR for scanned forms); P8 generators (Markdown, PDF via pdf-lib or Chromium print, DOCX via `docx`, XLSX via SheetJS, PPTX via pptxgenjs, charts as static SVG, itinerary/dashboard templates); Univer for spreadsheet editing; Sandpack React artifacts.
