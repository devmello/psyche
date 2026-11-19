import { beforeEach, describe, expect, it, vi } from "vitest";

/** Just enough of Electron's BrowserWindow for the ask panel; records call order. */
const h = vi.hoisted(() => {
  const calls: string[] = [];
  class FakeWc {
    handlers = new Map<string, (() => void)[]>();
    on(ev: string, fn: () => void) {
      const list = this.handlers.get(ev) ?? [];
      list.push(fn);
      this.handlers.set(ev, list);
      return this;
    }
    emit(ev: string) {
      for (const fn of this.handlers.get(ev) ?? []) fn();
    }
    setBackgroundThrottling(allowed: boolean) {
      calls.push(`throttle:${allowed}`);
    }
    isDestroyed() {
      return false;
    }
    isLoading() {
      return false;
    }
    send() {}
    focus() {}
  }
  class FakeBrowserWindow {
    static all: FakeBrowserWindow[] = [];
    webContents = new FakeWc();
    visible = false;
    handlers = new Map<string, (() => void)[]>();
    constructor() {
      FakeBrowserWindow.all.push(this);
    }
    on(ev: string, fn: () => void) {
      const list = this.handlers.get(ev) ?? [];
      list.push(fn);
      this.handlers.set(ev, list);
      return this;
    }
    emit(ev: string) {
      for (const fn of this.handlers.get(ev) ?? []) fn();
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setBounds() {}
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    isVisible() {
      return this.visible;
    }
    show() {
      calls.push("show");
      this.visible = true;
      this.emit("show");
    }
    hide() {
      this.visible = false;
      this.emit("hide");
    }
    focus() {}
    destroy() {}
  }
  return { calls, FakeBrowserWindow };
});

vi.mock("electron", () => ({
  BrowserWindow: h.FakeBrowserWindow,
  ipcMain: { on: () => {} },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
}));

const { ScreenAskWindow } = await import("../src/main/screen-ask/panel.ts");

function setup() {
  const panel = new ScreenAskWindow({
    url: (r) => `app://psyche${r}`,
    preloadPath: "/preload.cjs",
    onOpenThread: () => {},
  });
  panel.setEnabled(true);
  const win = h.FakeBrowserWindow.all.at(-1);
  if (!win) throw new Error("no window");
  return { panel, win };
}

describe("screen-ask panel throttling", () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.FakeBrowserWindow.all.length = 0;
  });

  it("is throttled once loaded while hidden", () => {
    const { win } = setup();
    win.webContents.emit("did-finish-load");
    expect(h.calls).toEqual(["throttle:true"]);
  });

  it("turns throttling off before show() when the shortcut opens it", () => {
    const { panel, win } = setup();
    win.webContents.emit("did-finish-load");
    h.calls.length = 0;
    panel.trigger("window");
    expect(h.calls.indexOf("throttle:false")).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf("throttle:false")).toBeLessThan(h.calls.indexOf("show"));
  });

  it("throttles again when the panel is hidden", () => {
    const { panel, win } = setup();
    win.webContents.emit("did-finish-load");
    panel.trigger("window");
    h.calls.length = 0;
    panel.hide();
    expect(h.calls).toEqual(["throttle:true"]);
  });
});
