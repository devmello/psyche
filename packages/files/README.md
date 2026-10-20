# @psyche/files

The agent's file tools (feature P9; architecture §4.3 built-ins), over the folders the owner granted in `permissions.policy.folders` (Settings → folder picker). Replaces INT-1's Gateway stand-in (#49).

## Public API

`fileTools(options?) → AgentToolRegistration[]`, registered by the Gateway composition:

| Tool | Side effect | Target | Notes |
| --- | --- | --- | --- |
| `read_file` | `read` | real path | 256 KiB per call, paged by byte `offset` / `nextOffset` without splitting UTF-8 characters; returns the file's `sha256` (files up to 4 MiB); binary files return `binary: true` and no text |
| `list_dir` | `read` | real path | names, kinds (`file` / `dir` / `link`), sizes; 500 per page; results always `untrusted` |
| `search_files` | `read` | real path | literal, case-insensitive by default; skips symlinks, binaries, hidden entries and `node_modules`; ≤ 5,000 files of ≤ 1 MiB, depth 12, 200 matches |
| `write_file` | `write` → `file_write` approval | real path | ≤ 1 MiB; binding `{operation: "overwrite", realPath, contentSha256}`; card shows the new content as a diff |
| `edit_file` | `write` → `file_write` approval | real path | exact-match replace (once, or `replace_all`); optional `expected_sha256` from `read_file`; `conflict` when the text is missing, ambiguous or the file changed (also re-checked right before the rename); card shows the replaced and new text as a diff; binding `{operation: "edit", realPath, contentSha256: sha256(edit)}` |

Options: `folders` (live granted folders; the executors refuse paths outside them and writes outside `rw` ones, behind the broker), `provenance` (a `FileProvenanceIndex`, in memory by default), `trustedRoots`, `now`.

## Security (docs/05 §3.5, §3.6)

- **Paths.** Absolute only; `..` resolves before the broker sees the target, so `/granted/../outside` is judged as `/outside`. Folder matching is by whole segments (`/granted-evil` is not under `/granted`).
- **Symlinks.** The broker compares paths without resolving links, so every tool refuses a path whose deepest existing ancestor is not its own real path or whose final component is a link (dangling or not); opens use `O_NOFOLLOW`; `search_files` never descends into a link. Granted folders must be real paths (on macOS `/private/tmp`, not `/tmp`).
- **Writes** go to a temporary file in the same folder and are renamed into place: a crash never leaves half a file, and a link or hard link at the path is replaced instead of written through.
- **Receipts.** `write` calls get a receipt from the agent loop (architecture §4.2 step 4); outputs carry `sha256` (and `previousSha256` for edits) for the transcript.
- **Provenance.** File contents are `untrusted` (non-workspace files, §3.6). Every write is recorded (`trusted`, or `untrusted` with the turn's taint sources when the turn is tainted), the host-side twin of the sandbox's `/workspace` index (#97). A read is `trusted` only under a configured `trustedRoots` folder, with a `trusted` record whose hash matches the current bytes. The Gateway configures no trusted roots, so every read taints the turn.

## Not yet

- PDF / DOCX / XLSX text extraction with page references (P9 "done when"), `move_file`, `delete_file`.
- A durable provenance store (records are in memory; a restart only makes files read as untrusted, and nothing reads them as trusted today).
