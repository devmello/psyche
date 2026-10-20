---
name: pdf-merge
description: Merge several PDFs from a granted folder into one file and save it next to them.
user-invocable: true
version: "1.0.0"
allowed-tools: [list_dir, read_file, write_file]
permissions: [file_write]
prompts: [prompts/naming.md]
---

# Merge PDFs

1. List the PDFs the owner named in the granted folder with `list_dir` and `read_file`.
2. Merge them in the order the owner gave; if no order was given, sort by file name.
3. Save the result with `write_file` as `<first-name>-merged.pdf`; the write asks for approval.
4. Tell the owner the new file's name and page count.

Naming rules are in `prompts/naming.md`.
