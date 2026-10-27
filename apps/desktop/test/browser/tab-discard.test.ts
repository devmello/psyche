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
    setBounds() {}
    setVisible() {}
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
    getContentBounds() {
      return { width: 800, height: 600 };
    }
    on() {}
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

const AFTER = 15 * 60_000;
let clock = 0;
let host: BrowserHost;
let win: InstanceType<typeof h.FakeWindow>;

function wcOf(tabId: string) {
  const tabs = (host as unknown as { tabs: Map<string, { wc: InstanceType<typeof h.FakeWc> }> })
    .tabs;
  const tab = tabs.get(tabId);
  if (tab === undefined) throw new Error("no tab");
  return tab.wc;
}
function state(tabId: string) {
  return host.getState().tabs.find((t) => t.tabId === tabId);
}
async function open(url: string, taskId?: string): Promise<string> {
  const tab = await host.open({ url, profile: "clean", ...(taskId ? { taskId } : {}) });
  wcOf(tab.tabId).title = `title of ${url}`;
  return tab.tabId;
}
function idle(ms = AFTER + 1000) {
  clock += ms;
  vi.advanceTimersByTime(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000;
  h.views.length = 0;
  win = new h.FakeWindow();
  host = new BrowserHost({
    window: win as never,
    psycheHome: "/nonexistent",
    userData: "/nonexistent",
    discardAfterMs: AFTER,
    discardCheckMs: 60_000,
    now: () => clock,
  });
});
afterEach(() => {
  host.dispose();
  vi.useRealTimers();
});

describe("idle tab discard", () => {
  it("discards an idle background tab but keeps its entry, id and position", async () => {
    const a = await open("https://a.example/");
    const b = await open("https://b.example/");
    // b is active (last opened); a is the background tab.
    idle();
    expect(state(a)).toMatchObject({
      discarded: true,
      url: "https://a.example/",
      title: "title of https://a.example/",
    });
    expect(state(b)?.discarded).toBeUndefined();
    expect(host.getState().tabs.map((t) => t.tabId)).toEqual([a, b]);
  });

  it("does not discard before the timeout", async () => {
    const a = await open("https://a.example/");
    await open("https://b.example/");
    idle(AFTER - 120_000);
    expect(state(a)?.discarded).toBeUndefined();
  });

  it("never discards the active tab", async () => {
    const a = await open("https://a.example/");
    idle(AFTER * 3);
    expect(state(a)?.discarded).toBeUndefined();
  });

  it("never discards a task tab", async () => {
    const a = await open("https://a.example/", "task_1");
    await open("https://b.example/");
    idle();
    expect(state(a)?.discarded).toBeUndefined();
  });

  it("never discards a tab under take-control, loading, audible or with CDP domains enabled", async () => {
    const owner = await open("https://owner.example/");
    const loading = await open("https://loading.example/");
    const audible = await open("https://audible.example/");
    const cdp = await open("https://cdp.example/");
    await open("https://front.example/");
    await host.setControl(owner, true);
    wcOf(loading).loading = true;
    wcOf(audible).audible = true;
    await host.cdpSend(cdp, "Runtime.enable", undefined);
    idle();
    for (const id of [owner, loading, audible, cdp]) expect(state(id)?.discarded).toBeUndefined();
  });

  it("never discards a popped-out tab", async () => {
    const a = await open("https://a.example/");
    await open("https://b.example/");
    await host.popOut(a);
    idle();
    expect(state(a)?.discarded).toBeUndefined();
  });

  it("agent use resets the idle clock", async () => {
    const a = await open("https://a.example/");
    await open("https://b.example/");
    idle(AFTER - 120_000);
    await host.setStatus(a, "working");
    idle(AFTER - 120_000);
    expect(state(a)?.discarded).toBeUndefined();
  });

  it("closes the old renderer and removes its view", async () => {
    const a = await open("https://a.example/");
    await open("https://b.example/");
    const old = wcOf(a);
    idle();
    expect(old.destroyed).toBe(true);
    expect(win.children.size).toBe(1);
  });
});

describe("restore", () => {
  it("activating a discarded tab recreates it on the same partition with the same URL", async () => {
    const a = await open("https://a.example/");
    await open("https://b.example/");
    const partition = h.views[0]?.prefs.partition;
    wcOf(a).zoom = 1.5;
    idle();
    await host.activateTab(a);
    const s = state(a);
    expect(s?.discarded).toBeUndefined();
    expect(s?.url).toBe("https://a.example/");
    expect(s?.zoomFactor).toBe(1.5);
    expect(host.getState().activeTabId).toBe(a);
    expect(h.views.at(-1)?.prefs.partition).toBe(partition);
    expect(host.getState().tabs.map((t) => t.tabId)).toEqual([a, "tab_2"]);
  });

  it("a bridge call on a discarded tab restores it first", async () => {
    const a = await open("https://a.example/");
    await open("https://b.example/");
    idle();
    expect(state(a)?.discarded).toBe(true);
    await host.cdpSend(a, "DOM.getDocument", {});
    expect(state(a)?.discarded).toBeUndefined();
    expect(wcOf(a).isDestroyed()).toBe(false);
    expect(wcOf(a).url).toBe("https://a.example/");
  });

  it("attach and navigate restore; close removes a discarded tab without restoring", async () => {
    const a = await open("https://a.example/");
    const c = await open("https://c.example/");
    await open("https://b.example/");
    idle();
    await host.attach(a);
    expect(state(a)?.discarded).toBeUndefined();
    await host.navigate(c, "reload");
    expect(state(c)?.discarded).toBeUndefined();
    idle();
    const views = h.views.length;
    await host.close(a);
    expect(h.views.length).toBe(views);
    expect(state(a)).toBeUndefined();
  });

  it("a restored tab can be discarded again after another idle period", async () => {
    const a = await open("https://a.example/");
    await open("https://b.example/");
    idle();
    await host.cdpSend(a, "DOM.getDocument", {});
    idle(AFTER - 120_000);
    expect(state(a)?.discarded).toBeUndefined();
    idle(240_000);
    expect(state(a)?.discarded).toBe(true);
  });
});
