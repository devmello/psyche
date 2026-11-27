import type { LayoutAction, LayoutState } from "./model.ts";

/** The route of a pane's pop-out window. */
export function popOutRoute(threadId: string, paneId: string): string {
  return `/chat/${threadId}/pane/${paneId}`;
}

/** Inverse of `popOutRoute`; null for any other route. */
export function parsePopOutRoute(route: string): { threadId: string; paneId: string } | null {
  const m = /^\/chat\/([^/]+)\/pane\/([^/]+)$/.exec(route);
  return m?.[1] && m[2] ? { threadId: m[1], paneId: m[2] } : null;
}

/**
 * Shows the built-in browser: its pane opens (or comes forward) in the main window. A pane that
 * is popped out is raised in its window while that exists; when the window is gone (its close was
 * missed) the pane docks again instead of staying hidden for good.
 */
export async function showBrowser(args: {
  threadId: string;
  state: LayoutState;
  focusPopOut?: (route: string) => Promise<boolean>;
  dispatch: (action: LayoutAction) => void;
}): Promise<void> {
  const { threadId, state } = args;
  const popped = state.panes.find((p) => p.pane === "browser" && state.popped.includes(p.paneId));
  if (popped) {
    const route = popOutRoute(threadId, popped.paneId);
    if (await args.focusPopOut?.(route).catch(() => false)) return;
    args.dispatch({ type: "popIn", paneId: popped.paneId });
    return;
  }
  args.dispatch({ type: "open", pane: "browser" });
}
