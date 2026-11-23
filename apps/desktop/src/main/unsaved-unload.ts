import { type BaseWindow, dialog, type WebContents } from "electron";

/**
 * A page that still holds unsaved Files edits blocks its unload (`beforeunload` in
 * packages/ui/src/screens/files/file-drafts.ts). Electron then cancels the reload or quit without a
 * word, so the owner is asked here instead: Discard lets it go ahead, Keep editing stops it.
 */
type Strings = { ask: string; discard: string; keep: string };
let strings: Strings | undefined;

/** Loads the dialog's words once, in the system's language. */
export function loadUnloadStrings(systemLocale: () => string): void {
  if (strings !== undefined) return;
  let locale: string;
  try {
    locale = systemLocale();
  } catch {
    return;
  }
  void import("@psyche/ui/i18n-core")
    .then(({ createI18n }) => {
      const i18n = createI18n({ locale });
      strings = {
        ask: i18n.t("screens.files.discardAsk"),
        discard: i18n.t("screens.files.discard"),
        keep: i18n.t("screens.files.keepEditing"),
      };
    })
    .catch(() => {});
}

/** The choice for one blocked unload: true lets it go ahead. Exported for tests. */
export function unloadChoice(
  ask: (o: Electron.MessageBoxSyncOptions) => number,
  words: Strings | undefined,
): boolean {
  // Without words to ask with, never trap the owner in an app that can't quit.
  if (words === undefined) return true;
  return (
    ask({
      type: "warning",
      message: words.ask,
      buttons: [words.discard, words.keep],
      defaultId: 1,
      cancelId: 1,
    }) === 0
  );
}

/**
 * Pages that report unsaved Files edits (the renderer's `psyche.files.setDirty`, IPC
 * `psyche:files:dirty`). Quitting does not reliably reach the page's `beforeunload` (a
 * BaseWindow's WebContentsView is torn down with its window), so the quit asks from this state.
 */
const dirtyPages = new Set<number>();
const watchedPages = new Set<number>();
/** The owner chose Discard for a quit: the page's own beforeunload must not ask a second time. */
let quitConfirmed = false;

/** A page reports whether it holds unsaved Files edits. A reload forgets the old page's report. */
export function reportFilesDirty(contents: WebContents, dirty: boolean): void {
  if (!watchedPages.has(contents.id)) {
    watchedPages.add(contents.id);
    const forget = () => dirtyPages.delete(contents.id);
    contents.on("did-start-loading", forget);
    contents.once("destroyed", () => {
      forget();
      watchedPages.delete(contents.id);
    });
  }
  if (dirty) dirtyPages.add(contents.id);
  else dirtyPages.delete(contents.id);
}

/** Whether any page still holds unsaved Files edits. */
export const hasUnsavedFiles = (): boolean => dirtyPages.size > 0;

/**
 * Called before the app quits: true lets the quit go ahead. With unsaved Files edits the owner is
 * asked first (Discard / Keep editing). The update-restart path can call this too.
 */
export function confirmQuitWithUnsaved(
  ask: (o: Electron.MessageBoxSyncOptions) => number = (o) => dialog.showMessageBoxSync(o),
): boolean {
  if (quitConfirmed || !hasUnsavedFiles()) return true;
  const go = unloadChoice(ask, strings);
  if (go) quitConfirmed = true;
  return go;
}

/** Tests: forget every page and the quit choice. */
export function resetUnsavedFilesForTests(): void {
  dirtyPages.clear();
  watchedPages.clear();
  quitConfirmed = false;
}

export function askBeforeUnload(contents: WebContents, win: BaseWindow): void {
  contents.on("will-prevent-unload", (event) => {
    // The owner already chose Discard for this quit: let the unload go ahead without asking again.
    if (quitConfirmed) {
      event.preventDefault();
      return;
    }
    const go = unloadChoice(
      (o) =>
        !win.isDestroyed() && win.isVisible()
          ? dialog.showMessageBoxSync(win, o)
          : dialog.showMessageBoxSync(o),
      strings,
    );
    // preventDefault here ignores the page's beforeunload, so the unload goes ahead.
    if (go) event.preventDefault();
  });
}
