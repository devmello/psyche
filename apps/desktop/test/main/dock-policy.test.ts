import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Just enough of Electron's windows and views for createAppWindows. */
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWebContents extends EventEmitter {
    destroyed = false;
    loadURL() {
      return Promise.resolve();
    }
    getURL() {
      return "";
    }
    isDestroyed() {
      return this.destroyed;
    }
    isLoading() {
      return false;
    }
    focus() {}
    close() {
      this.destroyed = true;
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
    minimized = false;
    contentView = { addChildView: () => undefined, removeChildView: () => undefined };
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
    /** Like Electron: "close" may be prevented; otherwise the window is destroyed. */
    close() {
      const event = {
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      this.emit("close", event);
      if (event.prevented) return;
      this.destroyed = true;
      this.visible = false;
      this.emit("closed");
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return this.minimized;
    }
    restore() {
      this.minimized = false;
    }
    focus() {}
    center() {}
    getContentBounds() {
      return { x: 0, y: 0, width: 1200, height: 800 };
    }
    getBounds() {
      return this.getContentBounds();
    }
    getNormalBounds() {
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

const { DockPolicy, SHOW_IN_DOCK_KEY, showInDock } = await import("../../src/main/dock-policy.ts");
const { createAppWindows } = await import("../../src/main/windows.ts");
const { BaseWindow } = (await import("electron")) as unknown as {
  BaseWindow: { all: FakeWindow[] };
};

interface FakeWindow {
  visible: boolean;
  minimized: boolean;
  isDestroyed(): boolean;
  show(): void;
  hide(): void;
  close(): void;
  emit(event: string, ...args: unknown[]): boolean;
}

const GRACE = 150;

function fakeApp(log: string[]) {
  return {
    setActivationPolicy: vi.fn((p: string) => void log.push(`policy:${p}`)),
    focus: vi.fn(() => void log.push("focus")),
    isHidden: vi.fn(() => false),
  };
}

function setup(platform: NodeJS.Platform = "darwin") {
  const log: string[] = [];
  const app = fakeApp(log);
  const dock = new DockPolicy({ app, platform, graceMs: GRACE });
  const popOutClosed: string[] = [];
  const windows = createAppWindows({
    rendererUrl: "app://psyche/",
    preloadPath: "/preload.cjs",
    dock,
    onPopOutClosed: (r) => popOutClosed.push(r),
  });
  // Every window shows as it loads; the mocked views never load, so do what that handler does.
  const logShows = (w: FakeWindow) => {
    const show = w.show.bind(w);
    w.show = () => {
      log.push("show");
      show();
    };
  };
  return { log, app, dock, windows, popOutClosed, logShows };
}

const main = (w: ReturnType<typeof setup>["windows"]) => w.showMain() as unknown as FakeWindow;
const settle = () => vi.advanceTimersByTime(GRACE);

describe("background mode: out of the Dock while no window is open", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    BaseWindow.all.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("closing the last window (the main window hides) switches to accessory", () => {
    const { windows, app } = setup();
    const win = main(windows);
    expect(app.setActivationPolicy).not.toHaveBeenCalled(); // already a regular app
    win.close(); // "Close window" hides the main window; the app and the tray keep running
    expect(win.visible).toBe(false);
    expect(app.setActivationPolicy).not.toHaveBeenCalled(); // not before the grace period
    settle();
    expect(app.setActivationPolicy).toHaveBeenCalledTimes(1);
    expect(app.setActivationPolicy).toHaveBeenCalledWith("accessory");
  });

  it("stays regular while any window is open (Settings, a pop-out)", () => {
    const { windows, app } = setup();
    const win = main(windows);
    windows.showSettings();
    const settings = BaseWindow.all[1] as FakeWindow;
    settings.show();
    windows.popOut("/chat/t_1/pane/files", "Files");
    win.close();
    settle();
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
    settings.close();
    settle();
    expect(app.setActivationPolicy).not.toHaveBeenCalled(); // the pop-out is still open
    (BaseWindow.all[2] as FakeWindow).close();
    settle();
    expect(app.setActivationPolicy).toHaveBeenCalledWith("accessory");
  });

  it("a minimized window still counts: it lives in the Dock", () => {
    const { windows, app } = setup();
    const win = main(windows);
    win.minimized = true;
    win.emit("minimize");
    settle();
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
  });

  it("blur, hide and minimize never leave the Dock: only closing the last window does", () => {
    const { windows, app } = setup();
    const win = main(windows);
    // Focus loss, minimize, ⌘H / Space-switch / occlusion "hide": the window still exists.
    win.emit("blur");
    win.minimized = true;
    win.emit("minimize");
    win.hide();
    settle();
    vi.advanceTimersByTime(60_000);
    expect(win.isDestroyed()).toBe(false);
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
    // Brought back and shown again, still regular; only "Close window" drops the icon.
    win.show();
    win.close();
    settle();
    expect(app.setActivationPolicy).toHaveBeenCalledTimes(1);
    expect(app.setActivationPolicy).toHaveBeenCalledWith("accessory");
  });

  it("two windows, one closed: stays regular; the last close switches", () => {
    const { windows, app } = setup();
    const win = main(windows);
    windows.showSettings();
    const settings = BaseWindow.all[1] as FakeWindow;
    settings.show();
    settings.close();
    settle();
    expect(app.setActivationPolicy).not.toHaveBeenCalled(); // main is still open
    win.close();
    settle();
    expect(app.setActivationPolicy).toHaveBeenCalledTimes(1);
    expect(app.setActivationPolicy).toHaveBeenCalledWith("accessory");
  });

  it("an unfocused window behind others, with a second one closed, stays regular", () => {
    const { windows, app } = setup();
    const win = main(windows);
    windows.popOut("/chat/t_1/pane/files", "Files");
    const pop = BaseWindow.all[1] as FakeWindow;
    win.emit("blur");
    win.hide(); // e.g. ⌘H
    pop.close();
    settle();
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
  });

  it("the quick-entry bar and other non-window surfaces (tray panel, overlay) are ignored", () => {
    const { windows, app } = setup();
    const win = main(windows);
    win.close();
    settle();
    expect(app.setActivationPolicy).toHaveBeenCalledTimes(1);
    // The quick-entry bar opening and blurring away does not bring the icon back or count.
    windows.toggleQuickEntry();
    const quick = BaseWindow.all[1] as FakeWindow;
    quick.emit("blur");
    // A panel/overlay window made outside createAppWindows is not tracked at all.
    const overlay = new (BaseWindow as unknown as new () => FakeWindow)();
    overlay.show();
    overlay.close();
    settle();
    expect(app.setActivationPolicy).toHaveBeenCalledTimes(1);
    expect(app.setActivationPolicy).toHaveBeenLastCalledWith("accessory");
  });

  it("no Dock flash when one window closes as another opens", () => {
    const { windows, app } = setup();
    const win = main(windows);
    win.close();
    vi.advanceTimersByTime(GRACE / 2);
    windows.showSettings();
    settle();
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
  });

  it("opening Psyche again (tray, relaunch, notification, deep link) is regular first, then shown, then focused", () => {
    const { windows, app, log, logShows } = setup();
    const win = main(windows);
    win.close();
    settle();
    log.length = 0;
    logShows(win);
    // Every one of those triggers lands in showMain (tray "Open Psyche", `activate`,
    // `second-instance`, notification click, deep link, hotkey command).
    windows.showMain();
    expect(log).toEqual(["policy:regular", "show", "focus"]);
    expect(app.setActivationPolicy).toHaveBeenLastCalledWith("regular");
    // Already regular: no second switch, and no focus steal.
    log.length = 0;
    windows.showMain();
    expect(log).toEqual(["show"]);
  });

  it("opening Settings or a pop-out from the menu bar also brings the icon back", () => {
    const { windows, app, log } = setup();
    main(windows).close();
    settle();
    expect(log).toEqual(["policy:accessory"]);
    windows.showSettings("appearance");
    expect(log).toEqual(["policy:accessory", "policy:regular", "focus"]);
    windows.popOut("/chat/t_1/pane/files", "Files");
    expect(app.setActivationPolicy).toHaveBeenCalledTimes(2);
  });

  it("a pop-out closing last docks its pane and leaves the Dock too", () => {
    const { windows, app, popOutClosed } = setup();
    windows.showMain().close();
    windows.popOut("/chat/t_1/pane/files", "Files");
    const pop = BaseWindow.all[1] as FakeWindow;
    pop.close();
    expect(popOutClosed).toEqual(["/chat/t_1/pane/files"]);
    settle();
    expect(app.setActivationPolicy).toHaveBeenCalledWith("accessory");
  });

  it("⌘Q quits fully: windows closing on quit do not switch the policy", () => {
    const { windows, app, dock } = setup();
    const win = main(windows);
    windows.showSettings();
    windows.setQuitting(); // before-quit
    dock.dispose();
    win.close(); // really closes now
    (BaseWindow.all[1] as FakeWindow).close();
    settle();
    expect(win.isDestroyed()).toBe(true);
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
  });

  it("the setting keeps the Dock icon when on, and applies live", () => {
    const { windows, app, dock } = setup();
    dock.setShowInDock(true);
    const win = main(windows);
    win.close();
    settle();
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
    // Turned off with no window open: the icon goes.
    dock.onSettingsChanged([{ key: SHOW_IN_DOCK_KEY, value: false }]);
    settle();
    expect(app.setActivationPolicy).toHaveBeenLastCalledWith("accessory");
    // Turned on again: it comes back without a window.
    dock.onSettingsChanged([{ key: SHOW_IN_DOCK_KEY, value: true }]);
    expect(app.setActivationPolicy).toHaveBeenLastCalledWith("regular");
  });

  it("defaults to off, whatever junk is stored", async () => {
    expect(showInDock(undefined)).toBe(false);
    expect(showInDock("true")).toBe(false);
    expect(showInDock(1)).toBe(false);
    expect(showInDock(true)).toBe(true);
    const { dock, app, windows } = setup();
    await dock.load(async () => ({ settings: {} }));
    main(windows).close();
    settle();
    expect(app.setActivationPolicy).toHaveBeenCalledWith("accessory");
  });

  it("reads the stored setting on load, and keeps the default when the Gateway is unpaired", async () => {
    const warn = vi.fn();
    const app = fakeApp([]);
    const dock = new DockPolicy({ app, platform: "darwin", graceMs: GRACE, warn });
    const call = vi.fn(async () => ({ settings: { [SHOW_IN_DOCK_KEY]: true } }));
    await dock.load(call);
    expect(call).toHaveBeenCalledWith("settings.get", { keys: [SHOW_IN_DOCK_KEY] });
    dock.windowsChanged(0);
    settle();
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
    await new DockPolicy({ app, platform: "darwin", warn }).load(async () => {
      throw new Error("unpaired");
    });
    expect(warn).toHaveBeenCalled();
  });

  it("⌘H keeps the icon until the app is unhidden", () => {
    const { windows, app } = setup();
    app.isHidden.mockReturnValue(true);
    main(windows).close();
    settle();
    vi.advanceTimersByTime(2000);
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
    app.isHidden.mockReturnValue(false);
    vi.advanceTimersByTime(2000);
    expect(app.setActivationPolicy).toHaveBeenCalledWith("accessory");
  });

  it("does nothing off macOS", () => {
    const { windows, app } = setup("linux");
    main(windows).close();
    settle();
    windows.showMain();
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
    expect(app.focus).not.toHaveBeenCalled();
  });

  it("a failing policy switch is logged, not thrown", () => {
    const warn = vi.fn();
    const app = fakeApp([]);
    app.setActivationPolicy.mockImplementation(() => {
      throw new Error("no");
    });
    const dock = new DockPolicy({ app, platform: "darwin", graceMs: 0, warn });
    expect(() => dock.windowsChanged(0)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(dock.policy).toBe("regular");
  });

  it("the renderer release keeps working in accessory mode", async () => {
    const log: string[] = [];
    const dock = new DockPolicy({ app: fakeApp(log), platform: "darwin", graceMs: GRACE });
    const released: unknown[] = [];
    const windows = createAppWindows({
      rendererUrl: "app://psyche/",
      preloadPath: "/preload.cjs",
      dock,
      releaseHiddenAfterMs: 1000,
      onMainViewCreated: (_w, v) => released.push(v),
    });
    const win = windows.showMain() as unknown as FakeWindow;
    win.close();
    vi.advanceTimersByTime(GRACE);
    expect(log).toEqual(["policy:accessory"]);
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(windows.mainContents()).toBeUndefined(); // freed while the app is an accessory
    windows.showMain();
    expect(windows.mainContents()).toBeDefined(); // and rebuilt on reopen
    expect(log).toEqual(["policy:accessory", "policy:regular", "focus"]);
  });
});

describe("background launch (unattended runs need the agent browser)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    BaseWindow.all.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("creates the host window hidden so the browser host and bridge come up with no window", async () => {
    const log: string[] = [];
    const dock = new DockPolicy({ app: fakeApp(log), platform: "darwin", graceMs: GRACE });
    const created: unknown[] = [];
    const windows = createAppWindows({
      rendererUrl: "app://psyche/",
      preloadPath: "/preload.cjs",
      dock,
      releaseHiddenAfterMs: 1000,
      onMainCreated: (w) => created.push(w),
    });
    windows.startHidden();
    // The browser host (built in onMainCreated) exists; nothing was shown or focused.
    expect(created).toHaveLength(1);
    const win = windows.main() as unknown as FakeWindow;
    expect(win.visible).toBe(false);
    vi.advanceTimersByTime(GRACE);
    expect(log).toEqual(["policy:accessory"]);
    // The 10-minute renderer free runs, but the window (and so the host and bridge) stays.
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(windows.mainContents()).toBeUndefined();
    expect(windows.main()).toBe(win);
    expect(win.isDestroyed()).toBe(false);
    // A second background start does not rebuild the host; opening from the menu bar shows it.
    windows.startHidden();
    expect(created).toHaveLength(1);
    windows.showMain();
    expect(created).toHaveLength(1);
    expect(windows.mainContents()).toBeDefined();
  });
});

describe("main.ts opens windows only through showMain", () => {
  const text = readFileSync(join(__dirname, "..", "..", "src", "main.ts"), "utf8");

  it("every way back in (tray, activate, second-instance, commands) goes through it", () => {
    expect(text).toMatch(/open: \(\) => windows\?\.showMain\(\)/);
    expect(text).toMatch(/app\.on\("activate", \(\) => windows\?\.showMain\(\)\)/);
    expect(text).toMatch(/app\.on\("second-instance"[\s\S]*?windows\?\.showMain\(\)/);
    expect(text).toMatch(/function command\(c: ShellCommand\): void \{\s*windows\?\.showMain\(\)/);
  });

  it("closing the last window does not quit on macOS, and the policy is wired in", () => {
    expect(text).toMatch(
      /app\.on\("window-all-closed", \(\) => \{\s*if \(process\.platform !== "darwin"\) app\.quit\(\)/,
    );
    expect(text).toContain("dock: dockPolicy");
    expect(text).toContain("dockPolicy.onSettingsChanged(entries)");
  });
});
