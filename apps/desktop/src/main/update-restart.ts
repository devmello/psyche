import { restartRefusal, type UpdateStatus } from "./update-status.ts";

/**
 * "Restart to update" (macOS), without Electron so it can be tested. The caller supplies the
 * platform, the status, the window hooks and `quitAndInstall`.
 *
 * `quitAndInstall` closes every window before `before-quit` runs. A window's close handler hides
 * the main window unless the app is quitting, so the quitting mark has to be set first (`beginQuit`),
 * or the restart never installs and the owner's pop-outs look closed. If the quit does not go ahead
 * (Squirrel's `error`, or an unsaved-edit prompt answered "Keep editing"), `cancelQuit` undoes the
 * mark and shows the main window again.
 */
export interface RestartDeps {
  platform: string;
  status: UpdateStatus;
  /** The windows stop hiding on close: the app is going to quit. */
  beginQuit(): void;
  /** The quit did not happen: the windows hide on close again and the main window shows. */
  cancelQuit(): void;
  quitAndInstall(): void;
}

/** How long a restart may take to quit before it is treated as not having gone ahead. */
export const RESTART_GIVE_UP_MS = 20_000;

let inProgress = false;
let giveUp: ReturnType<typeof setTimeout> | undefined;

/** Undoes an unfinished restart: the quitting mark is cleared and the main window shows. */
export function abandonRestart(cancelQuit: () => void): boolean {
  if (!inProgress) return false;
  inProgress = false;
  if (giveUp !== undefined) clearTimeout(giveUp);
  giveUp = undefined;
  cancelQuit();
  return true;
}

/**
 * Starts the restart. Returns the refusal reason when it does not start, undefined once it has
 * started. A second call while one is in progress does nothing (the owner clicked twice).
 */
export function restartToUpdate(deps: RestartDeps): string | undefined {
  if (inProgress) return undefined;
  const refusal = restartRefusal(deps.platform, deps.status);
  if (refusal) return refusal;
  inProgress = true;
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
  if (giveUp !== undefined) clearTimeout(giveUp);
  giveUp = undefined;
}
