# Decision memo: Markdown editor (S13, P5)

**Decision.** CodeMirror 6 is the editor in every mode. "Rich" is a live preview built from
decorations over the raw text (`richPreview` in `src/core/markdown-editor.ts`); "Source" is the same
editor without them; "Diff" is `@codemirror/merge`'s unified merge view. MDXEditor is not used.

## The bar (docs/06 §3.8, docs/03 P5)

1. Raw Markdown is canonical; Rich never rewrites untouched lines.
2. Rich / Source / Diff in one toggle; Diff against the last save or the agent's proposed edit.
3. Undo, autosave, conflict detection when the agent edits the same file.
4. Frontmatter-aware for `IDENTITY.md`; budget meters for persona files.
5. Permissive license, reasonable weight, works on `file://`-free Electron and the web client.

## Options

| | MDXEditor 4.3 | CodeMirror 6 + decorations |
| --- | --- | --- |
| Model | Lexical tree ⇄ mdast; Markdown is re-serialised from the tree | The Markdown text itself |
| Untouched lines | Normalised on export (list markers `*`→`-`, `__x__`→`**x**`, setext → ATX, table padding, reference links, spacing) | Byte-identical by construction |
| Raw HTML, footnotes, unknown syntax | Opaque nodes or lost unless a plugin models them | Kept (it is just text) |
| Rich / Source / Diff | Built in (`diffSourcePlugin`) | Built here: ~120 lines of decorations + `@codemirror/merge` |
| Frontmatter | Plugin (`js-yaml`) | Split/join helpers keep the block byte-for-byte unless edited |
| Weight | Lexical + CodeMirror + mdast stack | CodeMirror only (already used by the code viewer) |
| License | MIT | MIT |

MDXEditor's rich mode fails requirement 1: any edit exports the whole document through mdast, so a
one-word change can rewrite dozens of lines the user never touched, which would show up as noise
in Diff, in git sync (H10) and in dreaming's input. That is a correctness problem, not a styling one.

## Consequences

- Rich mode is "live preview" (Obsidian style), not a full WYSIWYG: tables and images show as
  formatted Markdown, not as widgets. Widgets can be added later as decorations without changing
  the text model.
- Round-trip tests (`test/markdown.test.ts`, `test/MarkdownEditor.test.tsx`) assert that an edit
  changes exactly the edited range for a fixture with frontmatter, nested lists, task lists, setext
  headings, tables, fenced and indented code, hard breaks, reference links, footnotes and raw HTML.
- Univer (spreadsheet editing) and a WYSIWYG table widget remain M2 items.
