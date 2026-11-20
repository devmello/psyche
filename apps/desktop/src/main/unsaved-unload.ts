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

export function askBeforeUnload(contents: WebContents, win: BaseWindow): void {
  contents.on("will-prevent-unload", (event) => {
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
