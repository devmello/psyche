# @psyche/files

The agent's file tools (feature P9; architecture §4.3 built-ins), over the folders the owner granted in `permissions.policy.folders` (Settings → folder picker). Replaces INT-1's Gateway stand-in (#49).

## Public API

`fileTools(options?) → AgentToolRegistration[]`, registered by the Gateway composition:

| Tool | Side effect | Target | Notes |
| --- | --- | --- | --- |
| `read_file` | `read` | real path | 256 KiB per call, paged by byte `offset` / `nextOffset` without splitting UTF-8 characters; returns the file's `sha256` (files up to 4 MiB); binary files return `binary: true` and no text; PDF, DOCX and XLSX return extracted text (below) |
| `list_dir` | `read` | real path | names, kinds (`file` / `dir` / `link`), sizes; 500 per page; results always `untrusted` |
| `search_files` | `read` | real path | literal, case-insensitive by default; skips symlinks, binaries, hidden entries and `node_modules`; ≤ 5,000 files of ≤ 1 MiB, depth 12, 200 matches |
| `write_file` | `write` → `file_write` approval | real path | ≤ 1 MiB; binding `{operation: "overwrite", realPath, contentSha256}`; card shows the new content as a diff |
| `edit_file` | `write` → `file_write` approval | real path | exact-match replace (once, or `replace_all`); optional `expected_sha256` from `read_file`; `conflict` when the text is missing, ambiguous or the file changed (also re-checked right before the rename); card shows the replaced and new text as a diff; binding `{operation: "edit", realPath, contentSha256: sha256(edit)}` |

## Document text (PDF, DOCX, XLSX)

`read_file` extracts text when the extension (`.pdf`, `.docx`/`.docm`, `.xlsx`/`.xlsm`) and the magic bytes (`%PDF-` in the first KiB, or a ZIP header) agree; otherwise the file reads as bytes. Output adds `format`, `unit` (`page` or `sheet`), `total`, `from`/`to` (1-based units returned) and `warnings`; `text` heads each unit with `[page 3]` or `[sheet Budget]` (`[page 3 cont.]` when a call resumes mid-page). About 64k characters per call; `nextOffset` packs the unit and a character offset (`unit × 10,000,000 + char`), so a call only extracts what it returns, and `page` (1-based page or sheet) jumps. Extracted text is always `untrusted`.

- **PDF**: PDF.js 6 (Node build, the library `@psyche/viewers` uses; no eval, no document JavaScript). Pages without a text layer are listed in `warnings`; no OCR here.
- **DOCX**: `word/document.xml`, paged at Word's `lastRenderedPageBreak` marks (the last saved layout), else at explicit page breaks, else one page.
- **XLSX**: one unit per sheet, rows as `12: a | b | c` from column A; shared and inline strings, booleans, cached formula values, and date formats as ISO dates.
- **Bounds**: files up to 64 MiB; extraction runs in a worker thread with a 512 MB heap and a 30 s deadline (terminated after it, or on cancel). DOCX/XLSX parts go through a small ZIP reader that inflates one part at a time with `node:zlib`'s `maxOutputLength` (64 MiB), so a zip bomb fails instead of filling memory. Error messages never quote document content.
- **Why not `@psyche/viewers/core`**: its entry statically imports dompurify, `@codemirror/merge`, pdf-lib and pptxgenjs, and the package depends on React and Univer. This package reuses its PDF.js choice and options instead.

Options: `folders` (live granted folders; the executors refuse paths outside them and writes outside `rw` ones, behind the broker), `provenance` (a `FileProvenanceIndex`, in memory by default), `trustedRoots`, `now`.

## Security (docs/05 §3.5, §3.6)

- **Paths.** Absolute only; `..` resolves before the broker sees the target, so `/granted/../outside` is judged as `/outside`. Folder matching is by whole segments (`/granted-evil` is not under `/granted`).
- **Symlinks.** The broker compares paths without resolving links, so every tool refuses a path whose deepest existing ancestor is not its own real path or whose final component is a link (dangling or not); opens use `O_NOFOLLOW`; `search_files` never descends into a link. Granted folders must be real paths (on macOS `/private/tmp`, not `/tmp`).
- **Writes** go to a temporary file in the same folder and are renamed into place: a crash never leaves half a file, and a link or hard link at the path is replaced instead of written through.
- **Receipts.** `write` calls get a receipt from the agent loop (architecture §4.2 step 4); outputs carry `sha256` (and `previousSha256` for edits) for the transcript.
- **Provenance.** File contents are `untrusted` (non-workspace files, §3.6). Every write is recorded (`trusted`, or `untrusted` with the turn's taint sources when the turn is tainted), the host-side twin of the sandbox's `/workspace` index (#97). A read is `trusted` only under a configured `trustedRoots` folder, with a `trusted` record whose hash matches the current bytes. The Gateway configures no trusted roots, so every read taints the turn.

## Not yet

- `move_file`, `delete_file`; OCR for scanned PDFs; PPTX and legacy `.doc`/`.xls`.
- A durable provenance store (records are in memory; a restart only makes files read as untrusted, and nothing reads them as trusted today).
