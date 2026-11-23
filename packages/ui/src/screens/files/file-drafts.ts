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
/**
 * Bumped each time the owner drops a path's draft (Discard, Reload, Overwrite, closing the pane).
 * An editor reports its draft as it unmounts (the spreadsheet editor does), which can land after
 * the drop: a report taken before the latest drop is ignored, so a dropped draft never comes back.
 */
const drops = new Map<string, number>();
/** Paths a mounted pane is editing with unsaved changes. */
const live = new Map<string, number>();
/** What the desktop app was last told about unsaved edits on this page. */
let reportedDirty = false;

/**
 * The desktop app learns whether this page holds unsaved edits (apps/desktop/src/main/unsaved-unload.ts),
 * so a quit can ask before it throws them away. Sent only when the state changes; the web has no bridge.
 */
function reportDirty(): void {
  const dirty = drafts.size > 0 || live.size > 0;
  if (dirty === reportedDirty) return;
  reportedDirty = dirty;
  try {
    (
      globalThis as { psyche?: { files?: { setDirty?: (d: boolean) => void } } }
    ).psyche?.files?.setDirty?.(dirty);
  } catch {
    // The bridge is gone (a page being torn down): nothing to tell.
  }
}

export const getDraft = (path: string): FileDraft | undefined => drafts.get(path);
export const hasDraft = (path: string | undefined): boolean =>
  path !== undefined && drafts.has(path);
/** The drop count of `path`: an editor takes it when it loads and passes it back with its drafts. */
export const draftEpoch = (path: string): number => drops.get(path) ?? 0;
/** Keeps `draft`, unless the owner dropped this path's draft after `epoch` was taken. */
export const putDraft = (path: string, draft: FileDraft, epoch = draftEpoch(path)): void => {
  if (epoch !== draftEpoch(path)) return;
  drafts.set(path, draft);
  reportDirty();
};
/** The editor itself has nothing unsaved any more (it went clean). */
export const clearDraft = (path: string | undefined): void => {
  if (path === undefined) return;
  drafts.delete(path);
  reportDirty();
};
/** The owner threw this path's unsaved edits away: forget them, and refuse late reports of them. */
export const dropDraft = (path: string | undefined): void => {
  if (path === undefined) return;
  drafts.delete(path);
  drops.set(path, draftEpoch(path) + 1);
  reportDirty();
};

/** A mounted pane reports (and withdraws) that it is editing `path` with unsaved changes. */
export function markLiveDirty(path: string, on: boolean): void {
  const n = (live.get(path) ?? 0) + (on ? 1 : -1);
  if (n <= 0) live.delete(path);
  else live.set(path, n);
  reportDirty();
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
  for (const path of live.keys()) dropDraft(path);
  return true;
}

/** Tests: forget everything. */
export function resetFileDrafts(): void {
  drafts.clear();
  drops.clear();
  live.clear();
  reportDirty();
}

/** Whether any unsaved Files edits are kept, on screen or in a tab that isn't showing. */
export const hasAnyDraft = (): boolean => drafts.size > 0;

// A reload or quit loses every kept draft, shown or not, so the page warns while any is kept.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", (e) => {
    if (drafts.size > 0 || live.size > 0) e.preventDefault();
  });
  // The desktop app asks this before it frees a hidden renderer (apps/desktop/src/main/release.ts):
  // a draft kept for a tab that isn't showing has no text field on the page to find.
  (window as { psycheUnsavedFiles?: () => boolean }).psycheUnsavedFiles = () =>
    drafts.size > 0 || live.size > 0;
}
