import { t } from "../../i18n/core.ts";

/**
 * Unsaved Files-pane edits, kept outside the component. The shell shows only the active tab of a
 * group, so a Files pane unmounts whenever another tab (an artifact the agent made, a second file)
 * takes over, and its local state would be lost. A draft is kept here by file path with the etag it
 * was based on, and restored when the pane comes back. It is cleared on Save, Discard and Reload.
 */

export interface FileDraft {
  /** What the editor held (a promise while a spreadsheet is still being converted). */
  content: string | Promise<string>;
  /** The etag of the file the draft started from. */
  etag: string;
}

const drafts = new Map<string, FileDraft>();
/** Paths a mounted pane is editing with unsaved changes. */
const live = new Map<string, number>();

export const getDraft = (path: string): FileDraft | undefined => drafts.get(path);
export const hasDraft = (path: string | undefined): boolean =>
  path !== undefined && drafts.has(path);
export const putDraft = (path: string, draft: FileDraft): void => {
  drafts.set(path, draft);
};
export const clearDraft = (path: string | undefined): void => {
  if (path !== undefined) drafts.delete(path);
};

/** A mounted pane reports (and withdraws) that it is editing `path` with unsaved changes. */
export function markLiveDirty(path: string, on: boolean): void {
  const n = (live.get(path) ?? 0) + (on ? 1 : -1);
  if (n <= 0) live.delete(path);
  else live.set(path, n);
}

/** Whether a Files pane now on screen holds unsaved edits. */
export const hasLiveDirty = (): boolean => live.size > 0;

/**
 * The shell calls this before it closes a Files pane: with unsaved edits on screen it asks, and
 * the answer yes drops those drafts. `ask` is the dialog (the browser's confirm by default).
 */
export function mayCloseFilesPane(
  ask: (message: string) => boolean = (m) =>
    typeof globalThis.confirm === "function" ? globalThis.confirm(m) : true,
): boolean {
  if (!hasLiveDirty()) return true;
  if (!ask(t("screens.files.discardAsk"))) return false;
  for (const path of live.keys()) drafts.delete(path);
  return true;
}

/** Tests: forget everything. */
export function resetFileDrafts(): void {
  drafts.clear();
  live.clear();
}
