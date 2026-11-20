/**
 * A warm, hidden panel should not run at full speed: with background throttling off its timers
 * keep firing and `document.visibilityState` stays "visible". Throttling is on while the window
 * is hidden and off again before it is shown, so the open stays instant (the DOM is already warm;
 * only timers were slowed, and nothing waits on them to paint).
 */
export interface ThrottledWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  on(event: "show" | "hide", cb: () => void): unknown;
  webContents: { setBackgroundThrottling(allowed: boolean): void; isDestroyed(): boolean };
}

export function throttleWhenHidden(win: ThrottledWindow): { beforeShow(): void; sync(): void } {
  const set = (allowed: boolean) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.setBackgroundThrottling(allowed);
    }
  };
  win.on("hide", () => set(true));
  win.on("show", () => set(false));
  return {
    /** Call just before `win.show()`. */
    beforeShow: () => set(false),
    /** Call once the first load is done: a window that never showed is hidden. */
    sync: () => set(!win.isVisible()),
  };
}
