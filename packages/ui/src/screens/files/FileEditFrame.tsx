import {
  FILE_WRITE_EXTENSIONS,
  FILE_WRITE_MAX_BYTES,
  FILE_WRITE_MAX_REQUEST_BYTES,
} from "@psyche/protocol";
import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { readFileBytes } from "../../data/files.ts";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import type { FolderGrant } from "../settings/types.ts";
import type { FileRef } from "./FilesPane.tsx";
import { clearDraft, draftEpoch, dropDraft, getDraft, putDraft } from "./file-drafts.ts";

/**
 * Editing a text file in the Files pane (`files.write`). The frame loads the file and its etag,
 * hands the editor the text and a `save`, and owns what the editors share: the etag the next
 * save must match, the "changed on disk" conflict flow (Reload, or Overwrite after a second
 * look at the etag and one more question), and the dirty flag the pane warns on.
 */

export type FileEditKind = "markdown" | "csv";

/** What a file is edited as, by name; `null` for what `files.write` does not save. */
export function fileEditKind(name: string): FileEditKind | null {
  const ext = /\.[^./\\]+$/.exec(name.toLowerCase())?.[0];
  if (ext === undefined || !(FILE_WRITE_EXTENSIONS as readonly string[]).includes(ext)) return null;
  return ext === ".csv" ? "csv" : "markdown";
}

/** Files over this many bytes are view only: `files.write` takes one frame's worth of text. */
export const EDIT_MAX_BYTES = FILE_WRITE_MAX_BYTES;

/**
 * Whether the pane may offer editing: a file path strictly under a folder shared read & write.
 * The longest matching folder decides, so a read-only folder inside a read & write one wins. The
 * Gateway checks again; this only decides what the pane shows.
 */
export function canEditPath(path: string | undefined, grants: readonly FolderGrant[]): boolean {
  if (path === undefined || fileEditKind(path) === null) return false;
  let best: FolderGrant | undefined;
  for (const g of grants) {
    const root = g.path.replace(/[\\/]+$/, "");
    if (!path.startsWith(root) || !/[\\/]/.test(path.charAt(root.length))) continue;
    if (best === undefined || root.length > best.path.replace(/[\\/]+$/, "").length) best = g;
  }
  return best?.access === "rw";
}

/** What an editor gets from the frame. */
export interface FileEditSession {
  file: FileRef;
  /**
   * The text as loaded. A Markdown or text file comes without its byte-order mark and with `\n`
   * line endings (the frame puts both back on save); a CSV file comes as it is on disk, and its
   * editor keeps the delimiter, line endings and mark itself.
   */
  text: string;
  /**
   * Unsaved edits kept from an earlier visit to this file (the pane was swapped out and came
   * back): the editor starts from these, with `text` as its saved baseline.
   */
  draft?: string;
  /**
   * The editor reports what it holds whenever it has unsaved changes, and `null` once it has
   * none. The frame keeps it outside the component, so it survives the pane being swapped out.
   */
  reportDraft: (content: string | Promise<string> | null) => void;
  /**
   * True while a save is under way or a conflict waits for an answer: the editor must not take
   * edits then, because Overwrite saves what the editor holds.
   */
  readOnly: boolean;
  /** Saves `content`. Resolves false when it did not save; the frame then says why. */
  save: (content: string) => Promise<boolean>;
  /** The editor reports unsaved edits, so the pane can ask before they are lost. */
  setDirty: (dirty: boolean) => void;
  /** Leave the editor at once. An editor with its own Done asks about unsaved edits first. */
  close: () => void;
}

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; text: string; draft?: string };

/** How the file on disk was written, so a save writes the same. */
interface Shape {
  bom: boolean;
  eol: "\n" | "\r\n";
}

const errorText = (err: unknown): string => describeError(err);

const bytesOf = (s: string): number => new TextEncoder().encode(s).length;

export function FileEditFrame({
  file,
  renderEditor,
  onDirtyChange,
  onClose,
}: {
  file: FileRef;
  renderEditor: (session: FileEditSession) => ReactNode;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
}): ReactElement {
  const call = useCall();
  const path = file.path ?? "";
  const csv = fileEditKind(file.name) === "csv";
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [fetchRev, setFetchRev] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [conflict, setConflict] = useState<null | "asked" | "confirm">(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const etag = useRef("");
  const shape = useRef<Shape>({ bom: false, eol: "\n" });
  const pending = useRef("");
  // The etag a draft started from; it survives a restore, so a changed file is noticed again.
  const draftBase = useRef<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  // The drop count this editor's drafts belong to. It moves on only after a remount has run the
  // old editor's cleanup, so a draft the old editor reports as it unmounts is ignored.
  const dropAt = useRef(draftEpoch(path));
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch and fetchRev mark a new editor
  useEffect(() => {
    dropAt.current = draftEpoch(path);
  }, [path, epoch, fetchRev]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetchRev is the reload trigger
  useEffect(() => {
    const ac = new AbortController();
    setLoaded({ status: "loading" });
    const fail = (message: string) => setLoaded({ status: "error", message });
    (async () => {
      const head = await call("files.read", { path, length: 1 });
      if (head.size > EDIT_MAX_BYTES) return fail(t("screens.files.editTooLarge"));
      const r = await readFileBytes(
        call,
        { path },
        { signal: ac.signal, maxBytes: EDIT_MAX_BYTES },
      );
      let raw: string;
      try {
        // ignoreBOM keeps the mark in the text, so nothing about the file is dropped.
        raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(r.bytes);
      } catch {
        return fail(t("screens.files.editNotText", { name: file.name }));
      }
      etag.current = r.etag;
      // Unsaved edits from an earlier visit come back; if the file changed meanwhile the
      // conflict flow starts at once, with the draft held read-only until the owner decides.
      const finish = async (text: string) => {
        const kept = getDraft(path);
        if (kept === undefined) return setLoaded({ status: "ready", text });
        let draft: string;
        try {
          draft = await kept.content;
        } catch {
          clearDraft(path);
          return setLoaded({ status: "ready", text });
        }
        if (ac.signal.aborted) return;
        draftBase.current = kept.etag;
        if (kept.etag === r.etag) setRestored(true);
        else {
          pending.current = draft;
          setConflict("asked");
        }
        setLoaded({ status: "ready", text, draft });
      };
      if (csv) {
        shape.current = { bom: false, eol: "\n" };
        return finish(raw);
      }
      const bom = raw.startsWith("﻿");
      const body = bom ? raw.slice(1) : raw;
      const crlf = (body.match(/\r\n/g) ?? []).length;
      const lf = (body.match(/\n/g) ?? []).length - crlf;
      // A bare CR (an old Mac file, or a stray one) counts as a third style.
      const loneCr = body.replace(/\r\n/g, "").includes("\r");
      if ((crlf > 0 && lf > 0) || loneCr) {
        return fail(t("screens.files.editMixedEol", { name: file.name }));
      }
      shape.current = { bom, eol: crlf > 0 ? "\r\n" : "\n" };
      await finish(crlf > 0 ? body.replace(/\r\n/g, "\n") : body);
    })().catch((err: unknown) => {
      if (ac.signal.aborted) return;
      fail(t("screens.files.editFailed", { name: file.name, reason: errorText(err) }));
    });
    return () => ac.abort();
  }, [call, path, file.name, csv, fetchRev]);

  const save = useCallback(
    async (content: string): Promise<boolean> => {
      setProblem(null);
      const { bom, eol } = shape.current;
      const text = eol === "\r\n" ? content.replace(/\r?\n/g, "\r\n") : content;
      const out = bom && !text.startsWith("﻿") ? `﻿${text}` : text;
      const params = { path, content: out, ifMatch: etag.current };
      // One frame is 1 MiB: refuse here, where the owner can read why, not at the socket.
      if (
        bytesOf(out) > FILE_WRITE_MAX_BYTES ||
        bytesOf(JSON.stringify(params)) >= FILE_WRITE_MAX_REQUEST_BYTES
      ) {
        setProblem(t("screens.files.saveTooLarge"));
        return false;
      }
      setBusy(true);
      try {
        const r = await call("files.write", params);
        etag.current = r.etag;
        draftBase.current = null;
        setRestored(false);
        setConflict(null);
        return true;
      } catch (err) {
        if ((err as { code?: unknown }).code === "conflict") {
          pending.current = content;
          setConflict("asked");
        } else {
          setProblem(t("screens.files.saveFailed", { name: file.name, reason: errorText(err) }));
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [call, path, file.name],
  );

  const reportDraft = useCallback(
    (content: string | Promise<string> | null) => {
      if (content === null) {
        draftBase.current = null;
        clearDraft(path);
        return;
      }
      draftBase.current ??= etag.current;
      putDraft(path, { content, etag: draftBase.current }, dropAt.current);
    },
    [path],
  );

  const setDirty = useCallback(
    (dirty: boolean) => {
      setIsDirty(dirty);
      onDirtyChange(dirty);
    },
    [onDirtyChange],
  );

  const reload = () => {
    draftBase.current = null;
    dropDraft(path);
    setRestored(false);
    setConflict(null);
    setProblem(null);
    onDirtyChange(false);
    // Back to loading at once: the editor must not remount on the old draft meanwhile.
    setLoaded({ status: "loading" });
    setFetchRev((n) => n + 1);
    setEpoch((n) => n + 1);
  };

  // Overwrite looks at the file again, so it replaces what is there now and nothing newer.
  const askOverwrite = async () => {
    try {
      const r = await call("files.read", { path, length: 1 });
      etag.current = r.etag;
      setConflict("confirm");
    } catch (err) {
      setProblem(t("screens.files.saveFailed", { name: file.name, reason: errorText(err) }));
    }
  };

  // The editor took no edits since the conflict, so what it holds is what the failed save held.
  const overwrite = async () => {
    const content = pending.current;
    if (await save(content)) {
      dropDraft(path);
      setLoaded({ status: "ready", text: content });
      setEpoch((n) => n + 1);
      onDirtyChange(false);
    } else {
      setConflict((c) => c ?? "asked");
    }
  };

  if (loaded.status === "loading") {
    return (
      <p role="status" className="p-4 text-sm text-label-secondary">
        {t("screens.files.editOpening", { name: file.name })}
      </p>
    );
  }
  if (loaded.status === "error") {
    return (
      <p role="alert" className="p-4 text-sm text-label-secondary">
        {loaded.message}
      </p>
    );
  }
  const readOnly = busy || conflict !== null;
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t("screens.files.editing", { name: file.name })}
    >
      {conflict !== null ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-separator px-3 py-2 text-callout"
        >
          <span className="min-w-0 flex-1">
            {conflict === "asked" ? t("screens.files.conflict") : t("screens.files.overwriteAsk")}
          </span>
          {conflict === "asked" ? (
            <>
              <Button type="button" size="xs" variant="outline" onClick={reload}>
                {t("screens.files.reload")}
              </Button>
              <Button type="button" size="xs" variant="outline" onClick={askOverwrite}>
                {t("screens.files.overwrite")}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="xs" onClick={overwrite}>
                {t("screens.files.overwriteConfirm")}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setConflict("asked")}
              >
                {t("common.cancel")}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {restored && isDirty && conflict === null ? (
        <p
          role="status"
          className="border-b border-separator px-3 py-1.5 text-callout text-label-secondary"
        >
          {t("screens.files.draftRestored")}
        </p>
      ) : null}
      {problem !== null ? (
        <p
          role="alert"
          className="border-b border-separator px-3 py-2 text-callout text-label-secondary"
        >
          {problem}
        </p>
      ) : null}
      {/* inert: an editor builds its read-only state once (CodeMirror) or has none (the sheet), so while a save runs or a conflict waits it takes no focus or edits. */}
      <div className="min-h-0 flex-1 overflow-auto" key={epoch} inert={readOnly}>
        {renderEditor({
          file,
          text: loaded.text,
          ...(loaded.draft === undefined ? {} : { draft: loaded.draft }),
          reportDraft,
          readOnly,
          save,
          setDirty,
          // An editor closes itself only when clean or after the owner chose Discard: either way
          // no draft may outlive it (the unmount report then carries a stale drop count).
          close: () => {
            dropDraft(path);
            onClose();
          },
        })}
      </div>
    </section>
  );
}
