import { describe, expect, it, vi } from "vitest";
import { createPopOutRegistry, type PopOutWindow } from "../src/main/pop-outs.ts";

function fakeWindow() {
  let closed: (() => void) | undefined;
  let destroyed = false;
  let minimized = false;
  const win = {
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: vi.fn(() => {
      minimized = false;
    }),
    show: vi.fn(),
    focus: vi.fn(),
    on: (_e: "closed", cb: () => void) => {
      closed = cb;
    },
  } satisfies PopOutWindow;
  return {
    win,
    minimize: () => {
      minimized = true;
    },
    close: () => {
      destroyed = true;
      closed?.();
    },
  };
}

describe("pop-out registry", () => {
  it("raises a live window and restores it when minimized", () => {
    const onClosed = vi.fn();
    const reg = createPopOutRegistry(onClosed);
    const a = fakeWindow();
    reg.add("/chat/t1/pane/p1", a.win);
    a.minimize();
    expect(reg.focus("/chat/t1/pane/p1")).toBe(true);
    expect(a.win.restore).toHaveBeenCalled();
    expect(a.win.focus).toHaveBeenCalled();
  });

  it("forgets a closed window and reports its route so the pane docks again", () => {
    const onClosed = vi.fn();
    const reg = createPopOutRegistry(onClosed);
    const a = fakeWindow();
    reg.add("/chat/t1/pane/p1", a.win);
    a.close();
    expect(onClosed).toHaveBeenCalledExactlyOnceWith("/chat/t1/pane/p1");
    expect(reg.has("/chat/t1/pane/p1")).toBe(false);
    expect(reg.focus("/chat/t1/pane/p1")).toBe(false);
  });

  it("drops a destroyed window it was never told about", () => {
    const reg = createPopOutRegistry(vi.fn());
    const a = fakeWindow();
    reg.add("/r", a.win);
    a.close();
    expect(reg.has("/r")).toBe(false);
  });

  it("does not report a stale window once a newer one took the route", () => {
    const onClosed = vi.fn();
    const reg = createPopOutRegistry(onClosed);
    const old = fakeWindow();
    const next = fakeWindow();
    reg.add("/r", old.win);
    reg.add("/r", next.win);
    old.close();
    expect(onClosed).not.toHaveBeenCalled();
    expect(reg.has("/r")).toBe(true);
    next.close();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
