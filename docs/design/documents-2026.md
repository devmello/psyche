# Documents as artifacts (2026)

Psyche creates and edits real documents as canvas artifacts, so the owner and the agent work on the same thing and every change is a version.

| Kind | `type` | Content | Agent ops | Export |
|---|---|---|---|---|
| Doc | `doc` | Markdown | `replaceSection`, `addSection`, `removeSection` (by heading), plus the text ops | `.docx`, `.pdf`, `.md` |
| Sheet | `workbook` | JSON `{sheets: [{name, cells: {A1: value or {f}}}]}` | `setCells`, `addSheet`, `renameSheet`, `removeSheet`; `sheet.read` returns computed values | `.xlsx`, `.csv` |
| Slides | `slides` | JSON `{theme, slides: [{id, layout, title, bullets, bullets2, image, notes}]}` | `addSlide`, `updateSlide`, `removeSlide`, `moveSlide`, `setTheme` | `.pptx`, `.pdf` |

## Merging

Agent and owner edits go through the same store (`apps/gateway/src/artifacts`): ops apply to a `base` version, a stale base returns a conflict with the missed ops, and history is never rewritten (`artifacts.restore` writes an old version as a new one). Patches address structure (a heading, a slide id, a cell), so edits to different parts do not collide. The canvas manifest tells the agent what the owner changed since its last version.

The pure models (section parser, deck and workbook ops, formula engine) live in `packages/protocol/src/documents.ts`, shared by the Gateway and the canvas. Formulas: arithmetic, `SUM AVERAGE MIN MAX COUNT COUNTA ABS SQRT ROUND IF AND OR NOT CONCAT LEN UPPER LOWER`, cross-sheet references, and `#DIV/0! #REF! #NAME? #VALUE! #CIRC!`.

## Import and write-back

`open_document` reads a `.docx .md .xlsx .csv .pptx` from a granted folder into a new artifact (best effort, marked untrusted because it came from a file; the result lists what was dropped). `write_document` writes an artifact back to a path in a granted read-write folder, in the format of the extension. It is a `file_write` approval bound to the exact path and artifact version, and the write is recorded in the change log (tool `write_document`, with before and after bytes) like `write_file`.

## Not carried

Doc: styles, comments, headers, images. Sheet: formatting, charts, images. Slides: shapes, masters, pictures (the `image` reference exports as nothing). Univer stays the editor for spreadsheet files opened as files; a host can take the workbook body over through the `renderArtifact` slot.

## Weight

Exporters and importers load on first use (dynamic imports, code-split chunks in the packaged Gateway, so idle memory is unchanged). The deck and workbook editors and the presenter are separate web chunks that load when such an artifact opens. `gatewayBundleMB` went from 6.5 to 9 for the exporter libraries (docx, pptxgenjs, xlsx, mammoth, jszip, pdf-lib) that ship as lazy chunks.
