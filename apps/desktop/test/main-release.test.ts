import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Just enough of Electron's windows and views for createAppWindows. */
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWebContents extends EventEmitter {
    url = "";
    destroyed = false;
    loadURL(u: string) {
      this.url = u;
      return Promise.resolve();
    }
    getURL() {
      return this.url;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isLoading() {
      return false;
    }
    close() {
      this.destroyed = true;
      this.emit("destroyed");
    }
  }
  class WebContentsView {
    webContents = new FakeWebContents();
    setBounds() {}
    setBackgroundColor() {}
  }
  class BaseWindow extends EventEmitter {
    static all: BaseWindow[] = [];
    visible = false;
    destroyed = false;
    contentView = {
      children: [] as unknown[],
      addChildView: (v: unknown, i?: number) => {
        if (i === undefined) this.contentView.children.push(v);
        else this.contentView.children.splice(i, 0, v);
      },
      removeChildView: (v: unknown) => {
        this.contentView.children = this.contentView.children.filter((c) => c !== v);
      },
    };
    constructor() {
      super();
      BaseWindow.all.push(this);
    }
    show() {
      this.visible = true;
      this.emit("show");
    }
    hide() {
      this.visible = false;
      this.emit("hide");
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    restore() {}
    focus() {}
    getContentBounds() {
      return { x: 0, y: 0, width: 1200, height: 800 };
    }
    getBounds() {
      return this.getContentBounds();
    }
    setBackgroundColor() {}
  }
  return {
    app: { getAppPath: () => "/app" },
    BaseWindow,
    WebContentsView,
    nativeTheme: { shouldUseDarkColors: false },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      getAllDisplays: () => [],
    },
  };
});

const { createAppWindows } = await import("../src/main/windows.ts");
const { BaseWindow, WebContentsView } = (await import("electron")) as unknown as {
  BaseWindow: { all: { contentView: { children: unknown[] } }[] };
  WebContentsView: new () => unknown;
};

const TEN_MIN = 10 * 60_000;
const flush = () => new Promise((r) => setImmediate(r));

function setup(canRelease: () => Promise<boolean> = async () => true) {
  const created: { webContents: { getURL(): string; isDestroyed(): boolean } }[] = [];
  const windows = createAppWindows({
    rendererUrl: "app://psyche/",
    preloadPath: "/preload.cjs",
    releaseHiddenAfterMs: TEN_MIN,
    canRelease,
    onMainViewCreated: (_w, v) => created.push(v as never),
  });
  const win = windows.showMain() as unknown as {
    hide(): void;
    contentView: { children: unknown[] };
  };
  return { windows, win, created };
}

describe("main renderer release while hidden in the menu bar", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    BaseWindow.all.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("frees the app view after ten minutes hidden, keeping the window and the tab views", async () => {
    const { windows, win, created } = setup();
    const tab = new WebContentsView();
    win.contentView.children.push(tab); // an agent browser tab above the app view
    const first = created[0];
    win.hide();
    vi.advanceTimersByTime(TEN_MIN - 1);
    expect(first?.webContents.isDestroyed()).toBe(false);
    vi.advanceTimersByTime(1);
    await flush();
    expect(first?.webContents.isDestroyed()).toBe(true);
    expect(windows.mainContents()).toBeUndefined();
    expect(win.contentView.children).toEqual([tab]);
    expect(windows.main()).toBeDefined();
  });

  it("rebuilds the app view on the route it left when shown again", async () => {
    const { windows, win, created } = setup();
    const first = created[0] as unknown as { webContents: { url: string } };
    first.webContents.url = "app://psyche/chat/t_1?pane=files#end";
    win.hide();
    vi.advanceTimersByTime(TEN_MIN);
    await flush();
    windows.showMain();
    expect(created).toHaveLength(2);
    expect(created[1]?.webContents.getURL()).toBe("app://psyche/chat/t_1?pane=files#end");
    expect(windows.mainContents()).toBe(created[1]?.webContents);
    expect(win.contentView.children[0]).toBe(created[1]);
  });

  it("keeps the renderer when the window is shown again within ten minutes", async () => {
    const { windows, win, created } = setup();
    win.hide();
    vi.advanceTimersByTime(TEN_MIN / 2);
    windows.showMain();
    vi.advanceTimersByTime(TEN_MIN);
    await flush();
    expect(created[0]?.webContents.isDestroyed()).toBe(false);
    expect(created).toHaveLength(1);
  });

  it("keeps unsent text: no release, and asks again later", async () => {
    let unsent = true;
    const { win, created } = setup(async () => !unsent);
    win.hide();
    vi.advanceTimersByTime(TEN_MIN);
    await flush();
    expect(created[0]?.webContents.isDestroyed()).toBe(false);
    unsent = false;
    vi.advanceTimersByTime(TEN_MIN);
    await flush();
    expect(created[0]?.webContents.isDestroyed()).toBe(true);
  });
});

describe("releaseHiddenAfterMs", async () => {
  const { RELEASE_HIDDEN_AFTER_MS, releaseHiddenAfterMs } = await import("../src/main/release.ts");
  it("is ten minutes, and only dev runs may change it", () => {
    expect(RELEASE_HIDDEN_AFTER_MS).toBe(TEN_MIN);
    expect(releaseHiddenAfterMs(true, { PSYCHE_RELEASE_HIDDEN_MS: "5" })).toBe(TEN_MIN);
    expect(releaseHiddenAfterMs(false, { PSYCHE_RELEASE_HIDDEN_MS: "5000" })).toBe(5000);
    expect(releaseHiddenAfterMs(false, { PSYCHE_RELEASE_HIDDEN_MS: "0" })).toBe(0);
    expect(releaseHiddenAfterMs(false, { PSYCHE_RELEASE_HIDDEN_MS: "soon" })).toBe(TEN_MIN);
    expect(releaseHiddenAfterMs(false, {})).toBe(TEN_MIN);
  });
});
