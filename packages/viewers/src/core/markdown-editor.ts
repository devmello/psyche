import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";

/**
 * CodeMirror 6 setup for Markdown (decision memo: docs/editor-decision.md). "Rich" mode is a
 * live preview made only of decorations over the raw text: markup marks are hidden on lines the
 * cursor is not on, headings / emphasis / code get styles. Nothing ever rewrites the document,
 * which is what "Rich never rewrites untouched lines" (docs/06 §3.8) requires.
 */

const HIDDEN_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "QuoteMark",
]);
const hide = Decoration.replace({});
const line = (cls: string) => Decoration.line({ class: cls });
const mark = (cls: string) => Decoration.mark({ class: cls });

const STYLES: Record<string, Decoration> = {
  ATXHeading1: line("cm-md-h1"),
  ATXHeading2: line("cm-md-h2"),
  ATXHeading3: line("cm-md-h3"),
  ATXHeading4: line("cm-md-h4"),
  ATXHeading5: line("cm-md-h5"),
  ATXHeading6: line("cm-md-h6"),
  SetextHeading1: line("cm-md-h1"),
  SetextHeading2: line("cm-md-h2"),
  Blockquote: line("cm-md-quote"),
  FencedCode: line("cm-md-codeblock"),
};
const INLINE: Record<string, Decoration> = {
  StrongEmphasis: mark("cm-md-strong"),
  Emphasis: mark("cm-md-em"),
  InlineCode: mark("cm-md-code"),
  Strikethrough: mark("cm-md-strike"),
  Link: mark("cm-md-link"),
};

function buildRich(state: import("@codemirror/state").EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const cursorLines = new Set<number>();
  for (const r of state.selection.ranges) {
    const from = state.doc.lineAt(r.from).number;
    const to = state.doc.lineAt(r.to).number;
    for (let n = from; n <= to; n++) cursorLines.add(n);
  }
  syntaxTree(state).iterate({
    enter(node) {
      const lineStyle = STYLES[node.name];
      if (lineStyle !== undefined) {
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) decos.push(lineStyle.range(state.doc.line(n).from));
      }
      const inline = INLINE[node.name];
      if (inline !== undefined && node.to > node.from) decos.push(inline.range(node.from, node.to));
      if (HIDDEN_MARKS.has(node.name) && node.to > node.from) {
        const ln = state.doc.lineAt(node.from);
        if (!cursorLines.has(ln.number) && node.to <= ln.to) {
          // Hide "# " together with its following space so headings start flush.
          const end =
            node.name === "HeaderMark" && state.sliceDoc(node.to, node.to + 1) === " "
              ? node.to + 1
              : node.to;
          decos.push(hide.range(node.from, end));
        }
      }
    },
  });
  return Decoration.set(decos, true);
}

/** Live-preview decorations (Rich mode). A StateField so it also works without a viewport. */
export const richPreview: Extension = [
  StateField.define<DecorationSet>({
    create: buildRich,
    update(value, tr) {
      return tr.docChanged || tr.selection !== undefined ? buildRich(tr.state) : value;
    },
    provide: (f) => EditorView.decorations.from(f),
  }),
  EditorView.baseTheme({
    ".cm-md-h1": { fontSize: "1.6em", fontWeight: "700" },
    ".cm-md-h2": { fontSize: "1.35em", fontWeight: "700" },
    ".cm-md-h3": { fontSize: "1.15em", fontWeight: "650" },
    ".cm-md-h4, .cm-md-h5, .cm-md-h6": { fontWeight: "650" },
    ".cm-md-strong": { fontWeight: "700" },
    ".cm-md-em": { fontStyle: "italic" },
    ".cm-md-strike": { textDecoration: "line-through" },
    ".cm-md-code": {
      fontFamily: "ui-monospace, monospace",
      background: "rgba(127,127,127,.15)",
      borderRadius: "3px",
    },
    ".cm-md-codeblock": {
      fontFamily: "ui-monospace, monospace",
      background: "rgba(127,127,127,.08)",
    },
    ".cm-md-quote": { borderLeft: "3px solid rgba(127,127,127,.4)", paddingLeft: "8px" },
    ".cm-md-link": { textDecoration: "underline" },
  }),
  // Rich reads as prose in the app's body face; code spans and fenced blocks keep the monospace
  // above, and Source / Diff (which do not load this) stay monospace throughout.
  EditorView.theme({
    ".cm-scroller": { fontFamily: "var(--font-sans, system-ui, sans-serif)", lineHeight: "1.6" },
    ".cm-md-code, .cm-md-codeblock": { fontFamily: "var(--font-mono, ui-monospace, monospace)" },
  }),
];

export interface MarkdownExtensionOptions {
  rich?: boolean;
  readOnly?: boolean;
}

/** The base Markdown setup (GFM, history, search, list continuation). */
export function markdownExtensions(opts: MarkdownExtensionOptions = {}): Extension[] {
  return [
    markdown({ base: markdownLanguage, addKeymap: false }),
    history(),
    highlightSelectionMatches(),
    keymap.of([
      ...markdownKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    EditorView.lineWrapping,
    ...(opts.rich ? [richPreview] : []),
    ...(opts.readOnly ? [EditorView.editable.of(false)] : []),
  ];
}
