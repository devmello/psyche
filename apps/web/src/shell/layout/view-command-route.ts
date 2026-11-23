/**
 * Which desktop window applies a `view.command`, and whether it raises the main window. Pure: the
 * shell's effect asks it, and the decision is unit-tested without Electron.
 *
 * Only the main window draws panes beside its screen, so only it applies a command, to the key it
 * shows (the chat on a chat screen, the screen's own key elsewhere). The Settings window cannot
 * draw them, so a command that opens a pane raises the main window, where the owner sees it. Pop-
 * outs and quick entry receive the same events and never act on them.
 */

export type ShellWindow = "main" | "settings" | "pop-out" | "quick";

export interface ViewCommandRoute {
  /** The layout key to apply the command to, or null when this window must not apply it. */
  applyTo: string | null;
  /** Bring the main window forward so the owner sees the pane. */
  raiseMain: boolean;
}

export function viewCommandRoute(input: {
  window: ShellWindow;
  /** The layout key the main window shows right now (null when there is none). */
  paneKey: string | null;
  /** The `view.command`'s `command` field (`open`, `close` or `focus`). */
  command: unknown;
}): ViewCommandRoute {
  if (input.window === "main") return { applyTo: input.paneKey, raiseMain: false };
  if (input.window === "settings") return { applyTo: null, raiseMain: input.command === "open" };
  return { applyTo: null, raiseMain: false };
}
