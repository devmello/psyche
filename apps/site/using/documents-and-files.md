---
title: Documents and files
---

# Documents and files

The agent works with files in two places: folders on your Mac that you share with it, and the Library, where Psyche keeps what the agent downloads, records or receives. You look at both in the Files pane, which opens PDFs, spreadsheets, Word documents, slides, images, email and code. Slides and other Office files can be converted to PDF in the sandbox for previewing.

## Turn it on

The agent reads and writes files only inside folders you share. Anything else is refused.

1. Open Settings → File access.
2. Under Folders, click **Share a folder** and pick a folder. It is shared Read only.
3. To let the agent save changes there, switch it to **Read and write**.
4. To stop sharing, remove it from the list.

Changes apply at once. Sharing a folder needs a device paired as admin; see [Getting started](/guides/getting-started) for how to make the app an admin device. On the web client there is no folder chooser: type the folder's full path.

Use real paths. A path through a symbolic link is refused, so on macOS share `/private/tmp`, not `/tmp`.

## What it can do

### The agent's file tools

| Tool | What it does |
| --- | --- |
| `read_file` | Reads a text file, or the text of a PDF, Word (DOCX) or Excel (XLSX) file |
| `list_dir` | Lists a folder |
| `search_files` | Searches file names and contents |
| `write_file` | Writes a file |
| `edit_file` | Changes part of a file |

- Reading a PDF, DOCX or XLSX file returns its text with `[page N]` or `[sheet Name]` markers, so the agent can cite where something is. Long documents come back in parts, about 64,000 characters at a time, and the agent can jump to a page.
- Text files come back 256 KiB per call. Files over 64 MB are refused.
- A search stops after 200 matches.
- Reads inside a shared folder run without asking. Every write asks, on a "Write file" card that shows the path and the change.

Text the agent reads from a file is untrusted content. Instructions inside a document are treated as data, never followed. See [Untrusted content](/security/taint).

### The Library

Click **Library** in the left rail. It has five tabs: Documents, Images, Artifacts, Downloads and System files. You can switch between Grid and List, and filter by Type, Source task and Date. **Open** on an item shows it in the Files pane.

What lands there:

- Files the agent downloads in its browser, and attachments sent to the agent over Telegram or iMessage. These are **quarantined**: they carry a "Quarantined" badge and are never opened automatically.
- Browser recordings, when recording is turned on.
- Read-aloud clips and voice memos.

Everything is stored under `~/.psyche/library/`. Downloads and channel attachments are in `library/quarantine/`.

::: info Screenshot placeholder
The Library with the Documents tab open in List view, showing a quarantined download with its badge and an Open button.
:::

### The Files pane

Open it from the command palette (⌘K, then "Open files pane"), or with **Open** on a Library item or an attachment. It shows a **Shared folders** tree built from your folder grants, and the **Library**. It works in the desktop app and the web client.

Viewers:

- **PDF**, with paging, zoom and search.
- **Spreadsheets** (XLSX, CSV and similar), with sheet tabs.
- **Word documents**, with a Layout view and a Text view.
- **Slides**, through conversion (below).
- **Images**, audio and video.
- **Email** (`.eml`), shown as sanitized HTML.
- **Code**, JSON, Markdown and plain text, with syntax highlighting.

A quarantined download opens with a note that it came from the web, and an Open button you click yourself.

### Document conversion

The Files pane can turn PowerPoint, Keynote, Word, Excel and OpenDocument files (`.pptx`, `.ppt`, `.odp`, `.key`, `.docx`, `.doc`, `.odt`, `.rtf`, `.xlsx`, `.xls`, `.ods`) into a PDF, or a picture of the first page, for previewing. Conversion runs LibreOffice inside the sandbox container, with no network. Files up to 10 MB are converted. Results are cached in `~/.psyche/cache/conversions`.

Conversion needs a container runtime (Apple `container` on macOS 26 and later, or Docker or Podman) and the full sandbox image, which includes LibreOffice. Without a runtime, the slides viewer says so. Without the full image, it shows the text of each slide instead.

## What it asks you

- **Writing or editing a file** in a shared folder: a "Write file" card with the path and the exact change. Allow once covers that one write.
- **Writing outside a shared folder, or to a Read only folder:** refused, with no card.
- **Opening a quarantined download:** you click Open yourself.

## Limits today

- Everything in the Files pane is view only. The Markdown editor (Rich, Source and Diff) and spreadsheet editing exist in the code, but the app does not turn them on yet. Edit files in another app, or ask the agent.
- The Library has no text search box yet, and you cannot filter by tag. Use Search in the left rail or ⌘K.
- Library actions such as "Trust this file", Quick Look, Reveal in Finder and Send to chat are not shown yet.
- Files you attach in chat may not appear in the Library; the Gateway has no upload method for the Library yet.
- The Artifacts and System files tabs are probably empty: nothing writes artifacts or system files into the Library yet. Edit persona and memory files in Soul & Memory instead (see [Memory](/using/memory)).
- Filling PDF forms from the viewer, and generating PDF, Word, Excel or slide files on request, are not in the app yet.

## Learn more

- [Getting started: share folders](/guides/getting-started)
- [Permissions](/security/permissions)
- [Untrusted content](/security/taint)
- [Files pane and viewers in the UI design](https://github.com/devmello/psyche/blob/main/docs/06-ui-design.md#37-files-pane-and-viewers)
- [Viewers package](https://github.com/devmello/psyche/tree/main/packages/viewers)
- [File tools package](https://github.com/devmello/psyche/tree/main/packages/files)
