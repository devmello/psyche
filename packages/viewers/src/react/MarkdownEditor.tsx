import { unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  DocumentSession,
  type DocumentStore,
  documentKind,
  formatBudget,
  joinFrontmatter,
  lineDiffStats,
  parseFrontmatter,
  type SessionState,
  splitFrontmatter,
} from "../core/markdown.ts";
import { markdownExtensions, richPreview } from "../core/markdown-editor.ts";
import { ViewerMessage } from "./states.tsx";

export type EditorMode = "rich" | "source" | "diff";

export interface MarkdownEditorProps {
  /** Workspace-relative path (persona budgets, MEMORY.md note) or a Library name. */
  path: string;
  store: DocumentStore;
  /** Autosave delay; default off for persona files (explicit Save), 1500 ms otherwise. */
  autosaveMs?: number | false;
  initialMode?: EditorMode;
  /** The agent's proposed edit (from an `edit_file` approval): Diff compares against it. */
  proposed?: { content: string; label?: string };
  /** Push a newer version seen by a file watcher; a dirty document goes to conflict. */
  remote?: { content: string; etag: string };
  readOnly?: boolean;
  onSaved?: (state: { content: string; etag: string }) => void;
}

/**
 * Markdown editor (P5, docs/06 §3.8). Raw Markdown is canonical: Rich is CodeMirror with
 * live-preview decorations, Source is plain CodeMirror, Diff is a unified merge view against the
 * last save (or the agent's proposal). Save is a compare-and-swap; an agent edit to the same file
 * shows as a conflict instead of being overwritten.
 */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const kind = documentKind(props.path);
  const autosave = props.autosaveMs ?? (kind.budget !== undefined ? false : 1500);
  const session = useMemo(
    () => new DocumentSession(props.store, { autosaveMs: autosave }),
    [props.store, autosave],
  );
  const state = useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.state,
  );
  useEffect(() => {
    void session.load();
    return () => session.dispose();
  }, [session]);
  const { onSaved, remote } = props;
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    if (state.status === "clean" && lastSaved.current !== state.etag) {
      if (lastSaved.current !== null) onSaved?.({ content: state.saved, etag: state.etag });
      lastSaved.current = state.etag;
    }
  }, [state, onSaved]);
  useEffect(() => {
    if (remote !== undefined) session.remoteChanged(remote);
  }, [remote, session]);

  if (state.status === "loading")
    return <ViewerMessage kind="loading" title={`Opening ${props.path}…`} />;
  if (state.status === "error" && state.saved === "" && state.content === "") {
    return (
      <ViewerMessage
        kind="error"
        title={`${props.path} could not be opened`}
        {...(state.error === undefined ? {} : { detail: state.error })}
      />
    );
  }
  return <EditorBody {...props} session={session} state={state} />;
}

function EditorBody(
  props: MarkdownEditorProps & { session: DocumentSession; state: SessionState },
) {
  const { session, state } = props;
  const kind = documentKind(props.path, state.content);
  const [mode, setMode] = useState<EditorMode>(
    props.initialMode ?? (props.proposed ? "diff" : "rich"),
  );
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const richSlot = useRef(new Compartment());

  // The editing view (rich / source). Created once; content is synced from the session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: created once per session.
  useEffect(() => {
    if (mode === "diff" || host.current === null) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: session.state.content,
        extensions: [
          markdownExtensions({ ...(props.readOnly ? { readOnly: true } : {}) }),
          richSlot.current.of(mode === "rich" ? richPreview : []),
          EditorView.contentAttributes.of({ "aria-label": `${props.path} editor` }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) session.edit(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [session, mode === "diff"]);

  useEffect(() => {
    view.current?.dispatch({
      effects: richSlot.current.reconfigure(mode === "rich" ? richPreview : []),
    });
  }, [mode]);

  // Session → editor (discard, conflict resolution, frontmatter panel, remote follow).
  useEffect(() => {
    const v = view.current;
    if (v === null) return;
    const doc = v.state.doc.toString();
    if (doc !== state.content)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: state.content } });
  }, [state.content]);

  const diffBase =
    state.status === "conflict" && state.conflict !== undefined
      ? state.conflict.content
      : state.saved;
  const diffDoc = props.proposed?.content ?? state.content;
  const stats = useMemo(() => lineDiffStats(diffBase, diffDoc), [diffBase, diffDoc]);

  const diffHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mode !== "diff" || diffHost.current === null) return;
    const v = new EditorView({
      parent: diffHost.current,
      state: EditorState.create({
        doc: diffDoc,
        extensions: [
          markdownExtensions({ readOnly: true }),
          EditorState.readOnly.of(true),
          unifiedMergeView({ original: diffBase, mergeControls: false, highlightChanges: true }),
          EditorView.contentAttributes.of({ "aria-label": `${props.path} diff` }),
        ],
      }),
    });
    return () => v.destroy();
  }, [mode, diffBase, diffDoc, props.path]);

  const fm = useMemo(() => splitFrontmatter(state.content), [state.content]);
  const fmParse = fm.yaml === null ? undefined : parseFrontmatter(fm.yaml);

  const status = {
    loading: "Loading",
    clean: "Saved",
    dirty: "Unsaved changes",
    saving: "Saving…",
    conflict: "Changed elsewhere",
    error: `Save failed${state.error ? `: ${state.error}` : ""}`,
  }[state.status];

  return (
    <div className="psy-md" data-mode={mode}>
      <div className="psy-md__bar" role="toolbar" aria-label="Editor">
        <span className="psy-md__name">{props.path}</span>
        <fieldset className="psy-segmented" aria-label="Mode">
          {(["rich", "source", "diff"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === "rich" ? "Rich" : m === "source" ? "Source" : "Diff"}
            </button>
          ))}
        </fieldset>
        {kind.budget === undefined ? null : (
          <meter
            aria-label="Prompt budget"
            min={0}
            max={kind.budget}
            value={state.content.length}
            high={kind.budget * 0.9}
            title={formatBudget(state.content.length, kind.budget)}
          />
        )}
        {kind.budget === undefined ? null : (
          <span className="psy-md__budget">{formatBudget(state.content.length, kind.budget)}</span>
        )}
        <output className="psy-md__status" data-status={state.status}>
          {status}
        </output>
        {mode === "diff" ? (
          <span className="psy-md__stats">
            +{stats.added} −{stats.removed}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void session.save()}
          disabled={props.readOnly || (state.status !== "dirty" && state.status !== "error")}
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => session.discard()}
          disabled={props.readOnly || state.status === "clean" || state.status === "saving"}
        >
          Discard
        </button>
      </div>
      {kind.rewrittenNightly ? (
        <p role="note">Dreaming rewrites MEMORY.md every night; your edits are kept as inputs.</p>
      ) : null}
      {kind.budget !== undefined && state.content.length > kind.budget ? (
        <p role="alert">
          Over budget: only the first {kind.budget.toLocaleString()} characters reach the prompt.
        </p>
      ) : null}
      {state.status === "conflict" && state.conflict !== undefined ? (
        <div className="psy-md__conflict" role="alert">
          <p>This file changed while you were editing (probably the agent).</p>
          <button type="button" onClick={() => void session.resolve("mine")}>
            Keep mine
          </button>
          <button type="button" onClick={() => void session.resolve("theirs")}>
            Take theirs
          </button>
          <button type="button" onClick={() => setMode("diff")}>
            Compare
          </button>
        </div>
      ) : null}
      {props.proposed !== undefined && mode === "diff" ? (
        <p role="note">Comparing with {props.proposed.label ?? "the agent's proposed edit"}</p>
      ) : null}
      {kind.frontmatter && fm.yaml !== null && mode !== "diff" ? (
        <details className="psy-md__frontmatter" open={props.path.endsWith("IDENTITY.md")}>
          <summary>Frontmatter</summary>
          <textarea
            aria-label="Frontmatter YAML"
            value={fm.yaml}
            readOnly={props.readOnly}
            spellCheck={false}
            onChange={(e) => session.edit(joinFrontmatter(fm, e.target.value, fm.body))}
          />
          {fmParse !== undefined && !fmParse.ok ? (
            <p role="alert">Frontmatter is not valid YAML: {fmParse.error}</p>
          ) : null}
        </details>
      ) : null}
      {mode === "diff" ? (
        <div ref={diffHost} className="psy-md__diff" />
      ) : (
        <div ref={host} className="psy-md__editor" />
      )}
    </div>
  );
}
