import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Minimal Electron doubles: just what BrowserHost touches. */
const h = vi.hoisted(() => {
  class FakeWc {
    static next = 1;
    id = FakeWc.next++;
    url = "";
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
      return "";
    }
    getZoomFactor() {
      return 1;
    }
    setZoomFactor() {}
    isLoading() {
      return false;
    }
    isCurrentlyAudible() {
      return false;
    }
    isDestroyed() {
      return this.destroyed;
    }
    loadURL(url: string) {
      this.url = url;
      return Promise.resolve();
    }
    executeJavaScriptInIsolatedWorld() {
      return Promise.resolve(undefined);
    }
    close() {
      this.destroyed = true;
      this.emit("destroyed");
    }
  }
  class FakeView {
    webContents: FakeWc;
    constructor(o: { webContents?: FakeWc }) {
      this.webContents = o.webContents ?? new FakeWc();
    }
    setBounds() {}
    setVisible() {}
  }
  class FakeWindow {
    contentView = { addChildView: () => {}, removeChildView: () => {} };
    isDestroyed() {
      return false;
    }
    isVisible() {
      return true;
    }
    isMinimized() {
      return false;
    }
    getContentBounds() {
      return { width: 800, height: 600 };
    }
    on() {}
    close() {}
    destroy() {}
    setFullScreen() {}
  }
  const session = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    on() {},
    webRequest: { onHeadersReceived() {} },
    flushStorageData() {},
    cookies: { get: async () => [], set: async () => {}, remove: async () => {} },
  };
  return { FakeView, FakeWindow, session };
});

vi.mock("electron", () => ({
  BaseWindow: h.FakeWindow,
  WebContentsView: h.FakeView,
  session: { fromPartition: () => h.session },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  },
}));

import { BrowserHost } from "../../src/main/browser/browser-host.ts";

type Internals = {
  capturePoller: { running: boolean; stop(): void };
  tabs: Map<string, { discarded: boolean }>;
  restoreTab(t: unknown): void;
};

let home: string;
let host: BrowserHost;
const poller = () => (host as unknown as Internals).capturePoller;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  home = mkdtempSync(join(tmpdir(), "psyche-host-capture-"));
  host = new BrowserHost({
    window: new h.FakeWindow() as never,
    psycheHome: home,
    userData: join(home, "userData"),
    captureEveryMs: 500,
  });
});
afterEach(() => {
  host.dispose();
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

describe("BrowserHost capture poller wiring", () => {
  it("sets no capture timer with no tabs, and none for an agent-held tab", async () => {
    const before = vi.getTimerCount();
    expect(poller().running).toBe(false);
    await host.open({ url: "https://example.com/", profile: "clean" });
    expect(poller().running).toBe(false);
    expect(vi.getTimerCount()).toBe(before);
  });

  it("starts when the owner takes control and stops after the owner lets go", async () => {
    const tab = await host.open({ url: "https://example.com/", profile: "clean" });
    await host.setControl(tab.tabId, true);
    expect(poller().running).toBe(true);
    await host.setControl(tab.tabId, false);
    vi.advanceTimersByTime(500);
    expect(poller().running).toBe(false);
  });

  it("stops after the owner-held tab is closed", async () => {
    const tab = await host.open({ url: "https://example.com/", profile: "clean" });
    await host.setControl(tab.tabId, true);
    expect(poller().running).toBe(true);
    await host.close(tab.tabId);
    vi.advanceTimersByTime(500);
    expect(poller().running).toBe(false);
  });

  it("starts again when an owner-held discarded tab is restored", async () => {
    const tab = await host.open({ url: "https://example.com/", profile: "clean" });
    await host.setControl(tab.tabId, true);
    poller().stop();
    expect(poller().running).toBe(false);
    const internals = host as unknown as Internals;
    const t = internals.tabs.get(tab.tabId);
    if (!t) throw new Error("no tab");
    t.discarded = true;
    internals.restoreTab(t);
    expect(poller().running).toBe(true);
  });
});
