import { describe, expect, it, vi } from "vitest";
import { throttleWhenHidden } from "../src/main/screen-ask/hidden-throttle.ts";

function fake(visible: boolean) {
  const handlers: Record<string, () => void> = {};
  const setBackgroundThrottling = vi.fn();
  const win = {
    visible,
    isDestroyed: () => false,
    isVisible: () => win.visible,
    on: (e: string, cb: () => void) => {
      handlers[e] = cb;
    },
    webContents: { setBackgroundThrottling, isDestroyed: () => false },
  };
  return { win, handlers, setBackgroundThrottling };
}

describe("throttleWhenHidden", () => {
  it("throttles on hide and unthrottles on show", () => {
    const { win, handlers, setBackgroundThrottling } = fake(true);
    throttleWhenHidden(win);
    handlers.hide?.();
    expect(setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    handlers.show?.();
    expect(setBackgroundThrottling).toHaveBeenLastCalledWith(false);
  });

  it("unthrottles before show so the open is instant", () => {
    const { win, setBackgroundThrottling } = fake(false);
    const t = throttleWhenHidden(win);
    t.sync();
    expect(setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    t.beforeShow();
    expect(setBackgroundThrottling).toHaveBeenLastCalledWith(false);
  });

  it("does nothing on a destroyed window", () => {
    const { win, handlers, setBackgroundThrottling } = fake(true);
    win.isDestroyed = () => true;
    throttleWhenHidden(win);
    handlers.hide?.();
    expect(setBackgroundThrottling).not.toHaveBeenCalled();
  });
});
