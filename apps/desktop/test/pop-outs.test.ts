import { describe, expect, it, vi } from "vitest";
import { checkRoute } from "../src/lib/ipc.ts";
import {
  createPopOutRegistry,
  isWatchPopOutRoute,
  type PopOutWindow,
  watchPopOutRoute,
} from "../src/main/pop-outs.ts";

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

describe("watch pane route", () => {
  it("is the web shell pane route for the computer-watch pane", () => {
    expect(watchPopOutRoute("t_123")).toBe("/chat/t_123/pane/computer-watch");
  });

  it("is a route the pop-out window accepts", () => {
    const route = watchPopOutRoute("0b6f2c1e-77aa-4c0e-9d3b-5a1f1c2d3e4f");
    expect(checkRoute("window:openPopOut", route)).toBe(route);
  });

  it("recognises only the watch pane route", () => {
    expect(isWatchPopOutRoute(watchPopOutRoute("t_123"))).toBe(true);
    // The web shell names a pop-out by pane id.
    expect(isWatchPopOutRoute("/chat/t_123/pane/p_computer-watch_2")).toBe(true);
    expect(isWatchPopOutRoute("/chat/t_123/pane/browser")).toBe(false);
    expect(isWatchPopOutRoute("/chat/t_123/pane/computer-watch/extra")).toBe(false);
    expect(isWatchPopOutRoute("/chat/pane/computer-watch")).toBe(false);
    expect(isWatchPopOutRoute("/settings")).toBe(false);
  });
});
