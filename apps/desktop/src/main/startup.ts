/**
 * The order the desktop app starts in (issue #441): the main window is shown before anything
 * waits on the Gateway, so first paint never depends on the supervisor or on pairing; the shell's
 * connection banner covers the time until the Gateway answers. A normal launch also makes Psyche
 * the active app: Chromium does not paint a window it considers hidden (an app started by another
 * process is not frontmost), and the owner who opened Psyche expects it in front. A login-item
 * launch stays in the background.
 */
export interface StartupDeps {
  /** Creates (if needed) and shows the main window. */
  showMain: () => void;
  /** Brings the app to the front (`app.focus({ steal: true })`). */
  focusApp: () => void;
  /** Creates the main window hidden, for a background launch. */
  startHidden?: () => void;
  /** Launched with `--background` (the Gateway starts Psyche for an unattended run). */
  background?: boolean;
  /** Starts the Gateway (supervisor) and connects; never awaited before the window shows. */
  startGateway: () => Promise<void>;
  /** Opened as a login item: don't take focus. */
  openedAtLogin: boolean;
  /** When the window was shown, for the first-paint probe. */
  onShown?: (at: number) => void;
  now?: () => number;
  warn?: (message: string) => void;
}

export function startShell(deps: StartupDeps): void {
  if (deps.background === true && deps.startHidden !== undefined) {
    // No window, no focus: the agent browser and its bridge run from the hidden main window.
    deps.startHidden();
  } else {
    deps.showMain();
    deps.onShown?.((deps.now ?? Date.now)());
    if (!deps.openedAtLogin) deps.focusApp();
  }
  void deps.startGateway().catch((err: unknown) => {
    deps.warn?.(`the Gateway did not start: ${err instanceof Error ? err.message : String(err)}`);
  });
}
