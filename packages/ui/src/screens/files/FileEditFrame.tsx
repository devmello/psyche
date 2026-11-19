import { FILE_WRITE_EXTENSIONS, FILE_WRITE_MAX_BYTES } from "@psyche/protocol";
import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { readFileBytes } from "../../data/files.ts";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import type { FolderGrant } from "../settings/types.ts";
import type { FileRef } from "./FilesPane.tsx";

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
  /** The text as loaded (or as last saved over a conflict). */
  text: string;
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
  | { status: "ready"; text: string };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [fetchRev, setFetchRev] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [conflict, setConflict] = useState<null | "asked" | "confirm">(null);
  const [problem, setProblem] = useState<string | null>(null);
  const etag = useRef("");
  const pending = useRef("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetchRev is the reload trigger
  useEffect(() => {
    const ac = new AbortController();
    setLoaded({ status: "loading" });
    readFileBytes(call, { path }, { signal: ac.signal, maxBytes: FILE_WRITE_MAX_BYTES }).then(
      (r) => {
        if (ac.signal.aborted) return;
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(r.bytes);
          etag.current = r.etag;
          setLoaded({ status: "ready", text });
        } catch {
          setLoaded({
            status: "error",
            message: t("screens.files.editNotText", { name: file.name }),
          });
        }
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        setLoaded({
          status: "error",
          message: t("screens.files.editFailed", { name: file.name, reason: errorText(err) }),
        });
      },
    );
    return () => ac.abort();
  }, [call, path, file.name, fetchRev]);

  const save = useCallback(
    async (content: string): Promise<boolean> => {
      setProblem(null);
      try {
        const r = await call("files.write", { path, content, ifMatch: etag.current });
        etag.current = r.etag;
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
      }
    },
    [call, path, file.name],
  );

  const reload = () => {
    setConflict(null);
    setProblem(null);
    onDirtyChange(false);
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

  const overwrite = async () => {
    const content = pending.current;
    if (await save(content)) {
      // The editor restarts on what was just saved, so it has nothing unsaved.
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
      {problem !== null ? (
        <p
          role="alert"
          className="border-b border-separator px-3 py-2 text-callout text-label-secondary"
        >
          {problem}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto" key={epoch}>
        {renderEditor({
          file,
          text: loaded.text,
          save,
          setDirty: onDirtyChange,
          close: onClose,
        })}
      </div>
    </section>
  );
}
