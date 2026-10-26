/**
 * The pane pop-out windows by route (`/chat/<thread>/pane/<pane>`). A window that is closed
 * (not only hidden) leaves the registry and tells the main window, which docks the pane again:
 * without that the layout keeps the pane "popped" and nothing ever shows it.
 */

/** The slice of a `BaseWindow` the registry uses. */
export interface PopOutWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  on(event: "closed", listener: () => void): unknown;
}

export interface PopOutRegistry {
  /** Registers a new window for `route`; its `closed` event unregisters it and calls `onClosed`. */
  add(route: string, win: PopOutWindow): void;
  /** Raises the live window for `route`; false when there is none (it was closed or never made). */
  focus(route: string): boolean;
  has(route: string): boolean;
}

export function createPopOutRegistry(onClosed: (route: string) => void): PopOutRegistry {
  const wins = new Map<string, PopOutWindow>();
  const live = (route: string): PopOutWindow | undefined => {
    const win = wins.get(route);
    if (win && !win.isDestroyed()) return win;
    wins.delete(route);
    return undefined;
  };
  return {
    add(route, win) {
      wins.set(route, win);
      win.on("closed", () => {
        // A newer window may have taken the route over; only the current one is stale state.
        if (wins.get(route) !== win) return;
        wins.delete(route);
        onClosed(route);
      });
    },
    focus(route) {
      const win = live(route);
      if (!win) return false;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return true;
    },
    has: (route) => live(route) !== undefined,
  };
}
