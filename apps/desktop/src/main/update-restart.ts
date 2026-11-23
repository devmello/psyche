import { restartRefusal, type UpdateStatus } from "./update-status.ts";

/**
 * "Restart to update" (macOS), without Electron so it can be tested. The caller supplies the
 * platform, the status, the unsaved-edits question, the window hooks and `quitAndInstall`.
 *
 * Order matters:
 * 1. `confirmQuit` asks about unsaved Files edits first (Discard / Keep editing). Closing the
 *    windows drops their dirty state, so this has to come before anything else. Keep editing
 *    refuses the restart and changes nothing.
 * 2. `beginQuit` marks the app quitting. `quitAndInstall` closes every window before `before-quit`
 *    runs, and a window's close handler hides the main window unless the app is quitting. Without
 *    the mark the update never installs, and pop-outs look closed to the owner.
 * 3. `commitRestart()` runs from `before-quit`: the quit is under way, so a late Squirrel error or
 *    the give-up timer must not undo it. Until then, `cancelQuit` undoes the mark and shows the
 *    main window again (Squirrel's `error`, a thrown `quitAndInstall`, or the give-up timer).
 */
export interface RestartDeps {
  platform: string;
  status: UpdateStatus;
  /** True to go on (nothing unsaved, or the owner chose Discard). False: the owner kept editing. */
  confirmQuit(): boolean;
  /** The windows stop hiding on close: the app is going to quit. */
  beginQuit(): void;
  /** The quit did not happen: the windows hide on close again and the main window shows. */
  cancelQuit(): void;
  quitAndInstall(): void;
}

/** How long a restart may take to quit before it is treated as not having gone ahead. */
export const RESTART_GIVE_UP_MS = 20_000;

/** Returned when the owner keeps editing: nothing changed, the update stays ready. */
export const KEEP_EDITING_REFUSAL = "unsaved edits are still open: save or discard them first";

let inProgress = false;
let committed = false;
let giveUp: ReturnType<typeof setTimeout> | undefined;

function clearGiveUp(): void {
  if (giveUp !== undefined) clearTimeout(giveUp);
  giveUp = undefined;
}

/** Undoes an unfinished restart: the quitting mark is cleared and the main window shows. */
export function abandonRestart(cancelQuit: () => void): boolean {
  if (!inProgress || committed) return false;
  inProgress = false;
  clearGiveUp();
  cancelQuit();
  return true;
}

/**
 * Called from `before-quit` once the quit is going ahead: the restart can no longer be undone, so
 * the give-up timer is dropped and a late error does not un-quit or show a window.
 */
export function commitRestart(): void {
  if (!inProgress) return;
  committed = true;
  clearGiveUp();
}

/**
 * Starts the restart. Returns the refusal reason when it does not start, undefined once it has
 * started. A second call while one is in progress does nothing (the owner clicked twice).
 */
export function restartToUpdate(deps: RestartDeps): string | undefined {
  if (inProgress) return undefined;
  const refusal = restartRefusal(deps.platform, deps.status);
  if (refusal) return refusal;
  if (!deps.confirmQuit()) return KEEP_EDITING_REFUSAL;
  inProgress = true;
  committed = false;
  deps.beginQuit();
  try {
    deps.quitAndInstall();
  } catch (err) {
    abandonRestart(deps.cancelQuit);
    throw err;
  }
  giveUp = setTimeout(() => {
    giveUp = undefined;
    abandonRestart(deps.cancelQuit);
  }, RESTART_GIVE_UP_MS);
  giveUp.unref?.();
  return undefined;
}

/** For tests: forgets an earlier restart without calling any hook. */
export function resetRestartForTests(): void {
  inProgress = false;
  committed = false;
  clearGiveUp();
}
