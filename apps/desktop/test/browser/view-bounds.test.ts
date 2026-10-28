import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Minimal Electron doubles: just what BrowserHost touches. */
const h = vi.hoisted(() => {
  class FakeWc {
    static next = 1;
    id = FakeWc.next++;
    url = "";
    title = "";
    zoom = 1;
    loading = false;
    audible = false;
    destroyed = false;
    attached = false;
    handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    on(ev: string, fn: (...a: unknown[]) => void) {
      const list = this.handlers.get(ev) ?? [];
      list.push(fn);
      this.handlers.set(ev, list);
      return this;
    }
    once(ev: string, fn: (...a: unknown[]) => void) {
      return this.on(ev, fn);
    }
    emit(ev: string, ...a: unknown[]) {
      for (const fn of this.handlers.get(ev) ?? []) fn(...a);
    }
    debugger = {
      on: () => {},
      isAttached: () => this.attached,
      attach: () => {
        this.attached = true;
      },
      detach: () => {
        this.attached = false;
      },
      sendCommand: async () => ({}),
    };
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    setWindowOpenHandler() {}
    getURL() {
      return this.url;
    }
    getTitle() {
      return this.title;
    }
    getZoomFactor() {
      return this.zoom;
    }
    setZoomFactor(z: number) {
      this.zoom = z;
    }
    isLoading() {
      return this.loading;
    }
    isCurrentlyAudible() {
      return this.audible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    loadURL(url: string) {
      this.url = url;
      return Promise.resolve();
    }
    close() {
      this.destroyed = true;
      this.emit("destroyed");
    }
  }
  const views: { webContents: FakeWc; prefs: { partition?: string } }[] = [];
  class FakeView {
    webContents: FakeWc;
    prefs: { partition?: string };
    constructor(o: { webPreferences?: { partition?: string }; webContents?: FakeWc }) {
      this.webContents = o.webContents ?? new FakeWc();
      this.prefs = o.webPreferences ?? {};
      views.push(this);
    }
    bounds: { x: number; y: number; width: number; height: number } | undefined;
    visible = false;
    setBounds(b: { x: number; y: number; width: number; height: number }) {
      this.bounds = b;
    }
    setVisible(v: boolean) {
      this.visible = v;
    }
  }
  class FakeWindow {
    children = new Set<unknown>();
    contentView = {
      addChildView: (v: unknown) => this.children.add(v),
      removeChildView: (v: unknown) => this.children.delete(v),
    };
    isDestroyed() {
      return false;
    }
    isVisible() {
      return true;
    }
    isMinimized() {
      return false;
    }
    content = { width: 1000, height: 700 };
    handlers = new Map<string, (() => void)[]>();
    getContentBounds() {
      return this.content;
    }
    on(ev: string, fn: () => void) {
      this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
    }
    emit(ev: string) {
      for (const fn of this.handlers.get(ev) ?? []) fn();
    }
    close() {}
    destroy() {}
    setFullScreen() {}
  }
  const ses = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    on() {},
    webRequest: { onHeadersReceived() {} },
  };
  return { FakeWc, FakeView, FakeWindow, views, ses };
});

vi.mock("electron", () => ({
  BaseWindow: h.FakeWindow,
  WebContentsView: h.FakeView,
  session: { fromPartition: () => h.ses },
}));

import { BrowserHost } from "../../src/main/browser/browser-host.ts";
import { computeViewBounds } from "../../src/main/browser/view-bounds.ts";

describe("computeViewBounds", () => {
  const content = { width: 1000, height: 700 };
  it("passes an in-window rect through", () => {
    expect(computeViewBounds({ x: 600, y: 100, width: 300, height: 500 }, content)).toEqual({
      x: 600,
      y: 100,
      width: 300,
      height: 500,
    });
  });
  it("scales by the renderer zoom", () => {
    expect(computeViewBounds({ x: 100, y: 50, width: 200, height: 100 }, content, 1.5)).toEqual({
      x: 150,
      y: 75,
      width: 300,
      height: 150,
    });
  });
  it("clamps to the content area on every side", () => {
    expect(computeViewBounds({ x: -20, y: -10, width: 1200, height: 900 }, content)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 700,
    });
  });
  it("returns null when the rect is entirely outside", () => {
    expect(computeViewBounds({ x: 1000, y: 0, width: 300, height: 300 }, content)).toBeNull();
    expect(computeViewBounds({ x: 0, y: 0, width: 0, height: 10 }, content)).toBeNull();
  });
  it("ignores a nonsense scale", () => {
    expect(computeViewBounds({ x: 1, y: 1, width: 5, height: 5 }, content, Number.NaN)).toEqual({
      x: 1,
      y: 1,
      width: 5,
      height: 5,
    });
  });
});

describe("BrowserHost view bounds", () => {
  let host: BrowserHost;
  let win: InstanceType<typeof h.FakeWindow>;
  const view = (i: number) => h.views[i] as unknown as InstanceType<typeof h.FakeView>;
  const rect = { x: 600, y: 100, width: 300, height: 500 };

  beforeEach(() => {
    vi.useFakeTimers();
    h.views.length = 0;
    win = new h.FakeWindow();
    host = new BrowserHost({
      window: win as never,
      psycheHome: "/nonexistent",
      userData: "/nonexistent",
      discardAfterMs: 1000,
      discardCheckMs: 500,
      now: () => Date.now(),
    });
  });
  afterEach(() => {
    host.dispose();
    vi.useRealTimers();
  });

  it("places and shows only the active tab, hides the rest and on null", async () => {
    await host.open({ url: "https://a.example/", profile: "clean" });
    const b = await host.open({ url: "https://b.example/", profile: "clean" });
    host.setViewport(rect);
    expect(view(1).bounds).toEqual(rect);
    expect([view(0).visible, view(1).visible]).toEqual([false, true]);
    await host.activateTab(
      (await host.open({ url: "https://c.example/", profile: "clean" })).tabId,
    );
    host.setViewport(null);
    expect(view(0).visible || view(1).visible || view(2).visible).toBe(false);
    expect(b.tabId).toBeTruthy();
  });

  it("re-clamps when the window shrinks, and hides when the pane falls outside", async () => {
    await host.open({ url: "https://a.example/", profile: "clean" });
    host.setViewport(rect);
    win.content = { width: 700, height: 700 };
    win.emit("resize");
    expect(view(0).bounds).toEqual({ x: 600, y: 100, width: 100, height: 500 });
    expect(view(0).visible).toBe(true);
    win.content = { width: 500, height: 700 };
    win.emit("resize");
    expect(view(0).visible).toBe(false);
    win.content = { width: 1000, height: 700 };
    win.emit("move");
    expect(view(0).bounds).toEqual(rect);
    expect(view(0).visible).toBe(true);
  });

  it("applies the renderer zoom", async () => {
    host.dispose();
    host = new BrowserHost({
      window: win as never,
      psycheHome: "/nonexistent",
      userData: "/nonexistent",
      rendererZoom: () => 1.25,
    });
    await host.open({ url: "https://a.example/", profile: "clean" });
    host.setViewport({ x: 400, y: 80, width: 400, height: 400 });
    expect(view(0).bounds).toEqual({ x: 500, y: 100, width: 500, height: 500 });
  });

  it("re-sends bounds to a tab restored from discard and to a tab switched to", async () => {
    const a = await host.open({ url: "https://a.example/", profile: "clean" });
    const b = await host.open({ url: "https://b.example/", profile: "clean" });
    host.setViewport(rect);
    vi.advanceTimersByTime(5000);
    expect(host.getState().tabs.find((t) => t.tabId === a.tabId)?.discarded).toBe(true);
    host.setViewport({ ...rect, x: 500 });
    await host.activateTab(a.tabId);
    const restored = h.views[h.views.length - 1] as unknown as InstanceType<typeof h.FakeView>;
    expect(restored).not.toBe(view(0));
    expect(restored.bounds).toEqual({ ...rect, x: 500 });
    expect(restored.visible).toBe(true);
    expect(view(1).visible).toBe(false);
    expect(b.tabId).toBeTruthy();
  });

  it("re-docks a popped-out tab at the current pane rect", async () => {
    const created: InstanceType<typeof h.FakeWindow>[] = [];
    const Base = h.FakeWindow;
    const a = await host.open({ url: "https://a.example/", profile: "clean" });
    host.setViewport(rect);
    // popOut constructs a second BaseWindow through the mocked class.
    const orig = Base.prototype.on;
    Base.prototype.on = function (this: InstanceType<typeof Base>, ev: string, fn: () => void) {
      if (!created.includes(this) && this !== win) created.push(this);
      return orig.call(this, ev, fn);
    };
    try {
      await host.popOut(a.tabId);
      expect(view(0).bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
      host.setViewport({ ...rect, x: 450 });
      created[0]?.emit("close");
    } finally {
      Base.prototype.on = orig;
    }
    expect(view(0).bounds).toEqual({ ...rect, x: 450 });
    expect(view(0).visible).toBe(true);
  });
});
