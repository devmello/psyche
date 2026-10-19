import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { type CodeToken, highlightTokens, languageFor } from "../core/code.ts";
import type { ViewerProps } from "./contract.ts";
import { Toolbar, ViewerMessage } from "./states.tsx";
import { useLoadable } from "./useBytes.ts";

const setTokens = StateEffect.define<CodeToken[]>();

const shikiField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setTokens)) continue;
      const ranges: Range<Decoration>[] = [];
      const len = tr.state.doc.length;
      for (const t of e.value) {
        if (t.to > len || t.color === undefined) continue;
        const style = `color:${t.color}${t.fontStyle !== undefined && (t.fontStyle & 1) !== 0 ? ";font-style:italic" : ""}${t.fontStyle !== undefined && (t.fontStyle & 2) !== 0 ? ";font-weight:bold" : ""}`;
        ranges.push(Decoration.mark({ attributes: { style } }).range(t.from, t.to));
      }
      return Decoration.set(ranges, true);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Large text stays plain beyond this size; CodeMirror itself handles multi-MB documents. */
const MAX_VIEW_BYTES = 20 * 1024 * 1024;

/**
 * Read-only code / text viewer (P4): CodeMirror 6 with line numbers, search and selection,
 * colored by Shiki 4. Selected lines can be sent to chat as line comments.
 */
export function CodeViewer(props: ViewerProps & { language?: string }) {
  const state = useLoadable(props.item.id, async (signal) => {
    const bytes = await props.load(signal);
    if (bytes.byteLength > MAX_VIEW_BYTES)
      throw new Error(`File is larger than ${MAX_VIEW_BYTES / 1024 / 1024} MB`);
    return new TextDecoder().decode(bytes);
  });
  if (state.status === "loading")
    return <ViewerMessage kind="loading" title={`Opening ${props.item.name}…`} />;
  if (state.status === "error")
    return (
      <ViewerMessage
        kind="error"
        title="This file could not be shown"
        detail={state.error.message}
      />
    );
  return (
    <CodeView
      {...props}
      text={state.value}
      language={props.language ?? languageFor(props.item.name)}
    />
  );
}

export function CodeView(props: ViewerProps & { text: string; language: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const { text, language, onSelectionChange } = props;

  useEffect(() => {
    if (host.current === null) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({
            tabindex: "0",
            "aria-label": `${props.item.name} source`,
          }),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of(searchKeymap),
          shikiField,
          EditorView.updateListener.of((u) => {
            if (!u.selectionSet || onSelectionChange === undefined) return;
            const sel = u.state.selection.main;
            if (sel.empty) return onSelectionChange(null);
            const from = u.state.doc.lineAt(sel.from).number;
            const to = u.state.doc.lineAt(sel.to).number;
            onSelectionChange({
              kind: "lines",
              from,
              to,
              text: u.state.sliceDoc(sel.from, sel.to).slice(0, 4000),
            });
          }),
        ],
      }),
    });
    view.current = v;
    let live = true;
    const dark =
      typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
    void highlightTokens(text, language, dark ? "dark" : "light").then((tokens) => {
      if (live && tokens.length > 0) v.dispatch({ effects: setTokens.of(tokens) });
    });
    return () => {
      live = false;
      v.destroy();
      view.current = null;
    };
  }, [text, language, onSelectionChange, props.item.name]);

  const sendSelection = () => {
    const v = view.current;
    if (v === null) return;
    const sel = v.state.selection.main;
    const from = v.state.doc.lineAt(sel.from).number;
    const to = v.state.doc.lineAt(sel.to).number;
    props.onSendToChat?.({
      itemId: props.item.id,
      name: props.item.name,
      ...(sel.empty
        ? {}
        : {
            selection: {
              kind: "lines" as const,
              from,
              to,
              text: v.state.sliceDoc(sel.from, sel.to).slice(0, 4000),
            },
            quote: v.state.sliceDoc(sel.from, sel.to).slice(0, 1000),
          }),
    });
  };

  return (
    <div className="psy-code" data-language={language}>
      {props.compact ? null : (
        <Toolbar label="Code">
          <span>{language === "text" ? "Plain text" : language}</span>
          <span>{text.split("\n").length.toLocaleString()} lines</span>
          {props.onSendToChat ? (
            <button type="button" onClick={sendSelection}>
              Send to chat
            </button>
          ) : null}
          {props.onOpenInPane ? (
            <button
              type="button"
              onClick={() => props.onOpenInPane?.({ pane: "editor", target: props.item.id })}
            >
              Edit
            </button>
          ) : null}
        </Toolbar>
      )}
      <div ref={host} className="psy-code__editor" />
    </div>
  );
}
