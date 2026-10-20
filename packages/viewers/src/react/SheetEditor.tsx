import { useEffect, useRef, useState } from "react";
import {
  editableSheetFormat,
  fromUniverSnapshot,
  SHEET_MIME,
  type SnapshotLoss,
  toUniverSnapshot,
  type UniverSnapshot,
} from "../core/sheet-edit.ts";
import type { ViewerProps } from "./contract.ts";
import { Toolbar, ViewerMessage } from "./states.tsx";
import { loadUniverRuntime, type SheetEditorRuntime, type SheetEditorSession } from "./univer.ts";
import { useLoadable } from "./useBytes.ts";

export interface SheetEditorProps extends ViewerProps {
  /** Back to the read-only viewer. Unsaved edits ask first. */
  onClose: () => void;
}

/** What `fromUniverSnapshot` cannot write back, said before the first save. */
export function lossNote(loss: SnapshotLoss): string | undefined {
  const parts = [
    loss.styled ? "cell formatting (fonts, fills, borders)" : undefined,
    loss.comments ? "comments" : undefined,
    loss.images ? "images" : undefined,
    loss.links ? "hyperlinks" : undefined,
    loss.arrays ? "array formulas (saved as ordinary formulas)" : undefined,
  ].filter((p): p is string => p !== undefined);
  const names = loss.names
    ? " Named ranges are kept in the file, but formulas using them show #NAME? here."
    : "";
  if (parts.length === 0) return names === "" ? undefined : names.trim();
  return `Saving keeps values, formulas, number formats, merges and sizes, but not ${parts.join(", ")}.${names}`;
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * Spreadsheet edit mode (P3, ADR-013): Univer's sheets UI over a snapshot that SheetJS CE built
 * from the file, written back to the same format on Save. Explicit Save, as for persona files
 * (docs/06 §3.8); nothing autosaves a spreadsheet.
 */
export function SheetEditor(props: SheetEditorProps) {
  const state = useLoadable(props.item.id, async (signal) => {
    const [snapshot, runtime] = await Promise.all([
      props.load(signal).then((bytes) => toUniverSnapshot(bytes, props.item.name)),
      (props.sheetEditor ?? loadUniverRuntime)(),
    ]);
    return { snapshot, runtime };
  });
  if (state.status === "loading")
    return <ViewerMessage kind="loading" title={`Opening ${props.item.name} for editing…`} />;
  if (state.status === "error")
    return (
      <div className="psy-sheet-editor">
        <ViewerMessage
          kind="error"
          title="This spreadsheet cannot be edited here"
          detail={state.error.message}
        />
        <button type="button" onClick={props.onClose}>
          Back to viewer
        </button>
      </div>
    );
  return <EditorSurface {...props} {...state.value} />;
}

function EditorSurface(
  props: SheetEditorProps & { snapshot: UniverSnapshot; runtime: SheetEditorRuntime },
) {
  const { snapshot, runtime } = props;
  const host = useRef<HTMLDivElement>(null);
  const session = useRef<SheetEditorSession | null>(null);
  const [dirty, setDirty] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    const s = runtime.mount(el, snapshot.data);
    session.current = s;
    const off = s.onChange(() => {
      setDirty(true);
      setSave((prev) => (prev.kind === "saved" ? { kind: "idle" } : prev));
    });
    return () => {
      off();
      s.dispose();
      session.current = null;
    };
  }, [runtime, snapshot]);

  const onSave = async () => {
    const s = session.current;
    if (s === null || props.onSave === undefined) return;
    setSave({ kind: "saving" });
    try {
      const bytes = await fromUniverSnapshot(s.snapshot(), snapshot.format, snapshot.carry);
      await props.onSave({ name: props.item.name, mime: SHEET_MIME[snapshot.format], bytes });
      setDirty(false);
      setSave({ kind: "saved" });
    } catch (error) {
      setSave({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const note = lossNote(snapshot.loss);
  const csvNote =
    snapshot.format === "csv" || snapshot.format === "tsv"
      ? `Saving writes the first sheet's values as ${snapshot.format.toUpperCase()} in the file's own delimiter and line endings; formulas become their results.`
      : undefined;

  return (
    <div
      className="psy-sheet-editor"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <Toolbar label="Spreadsheet editor">
        <span>{dirty ? "Unsaved changes" : save.kind === "saved" ? "Saved" : "No changes"}</span>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || save.kind === "saving" || props.onSave === undefined}
        >
          {save.kind === "saving" ? "Saving…" : "Save"}
        </button>
        {confirmClose ? (
          <span role="alertdialog" aria-label="Discard unsaved changes?" aria-modal="false">
            Discard unsaved changes?{" "}
            <button type="button" onClick={props.onClose}>
              Discard
            </button>
            {/* Focus moves here when the question appears ("Done" just unmounted). */}
            {/* biome-ignore lint/a11y/noAutofocus: replaces the focused Done button */}
            <button type="button" autoFocus onClick={() => setConfirmClose(false)}>
              Keep editing
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => (dirty ? setConfirmClose(true) : props.onClose())}>
            Done
          </button>
        )}
      </Toolbar>
      {note !== undefined || csvNote !== undefined ? (
        <p role="note" className="psy-sheet-editor__note">
          {[note, csvNote].filter(Boolean).join(" ")}
        </p>
      ) : null}
      {save.kind === "error" ? (
        <p role="alert" className="psy-sheet-editor__error">
          Could not save: {save.message}
        </p>
      ) : null}
      <div
        ref={host}
        className="psy-sheet-editor__surface"
        data-testid="sheet-editor-surface"
        role="application"
        aria-label="Spreadsheet editor"
        aria-roledescription="spreadsheet"
        style={{ flex: 1, minHeight: 360, position: "relative" }}
      />
    </div>
  );
}

/** True when the file can be opened in the editor and written back to its own format. */
export function canEditSheet(props: Pick<ViewerProps, "item" | "onSave">): boolean {
  return props.onSave !== undefined && editableSheetFormat(props.item.name) !== undefined;
}
