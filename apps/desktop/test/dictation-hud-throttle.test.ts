import { beforeEach, describe, expect, it, vi } from "vitest";

/** Electron doubles: the HUD window, its renderer's IPC and the display it is placed on. */
const h = vi.hoisted(() => {
  const log: string[] = [];
  const listeners = new Map<string, (e: unknown, arg: unknown) => void>();
  const windows: FakeWindow[] = [];
  class FakeWindow {
    visible = false;
    destroyed = false;
    sent: unknown[][] = [];
    webContents = {
      setBackgroundThrottling: (allowed: boolean) => log.push(`throttle:${allowed}`),
      send: (...args: unknown[]) => {
        this.sent.push(args);
      },
      isDestroyed: () => false,
      on: () => {},
    };
    constructor() {
      windows.push(this);
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    setBounds() {}
    on() {}
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    showInactive() {
      this.visible = true;
      log.push("showInactive");
    }
    hide() {
      this.visible = false;
      log.push("hide");
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { log, listeners, windows, FakeWindow };
});

vi.mock("electron", () => ({
  BrowserWindow: h.FakeWindow,
  ipcMain: {
    on: (ch: string, fn: (e: unknown, arg: unknown) => void) => h.listeners.set(ch, fn),
  },
  screen: {
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
}));

import { IPC } from "../src/lib/ipc.ts";
import { HudWindow } from "../src/main/dictation/hud.ts";

function makeHud() {
  return new HudWindow({
    url: (route) => `app://${route}`,
    preloadPath: "/preload.js",
    onAudio: () => {},
  });
}

/** The window's latest capture command and its id. */
function lastCommand(win: InstanceType<typeof h.FakeWindow>) {
  const call = win.sent.filter((a) => a[0] === IPC.dictationCapture).at(-1);
  return call?.[1] as { id: number; command: string };
}

function ack(id: number, open = false) {
  const fn = h.listeners.get(IPC.dictationCaptured);
  fn?.({ sender: h.windows[0]?.webContents }, { id, ok: true, open });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.log.length = 0;
  h.windows.length = 0;
  h.listeners.clear();
});

describe("dictation HUD background throttling", () => {
  it("is throttled from creation, while hidden", async () => {
    const hud = makeHud();
    await hud.warm();
    expect(h.log).toEqual(["throttle:true"]);
    expect(h.windows[0]?.visible).toBe(false);
  });

  it("is unthrottled before it is shown, so the HUD appears at once", async () => {
    const hud = makeHud();
    hud.show({ phase: "listening", app: "Notes", text: "" });
    await hud.warm();
    const unthrottle = h.log.lastIndexOf("throttle:false");
    expect(unthrottle).toBeGreaterThan(-1);
    expect(unthrottle).toBeLessThan(h.log.indexOf("showInactive"));
    expect(h.windows[0]?.visible).toBe(true);
  });

  it("is throttled again when hidden with no microphone open", async () => {
    const hud = makeHud();
    hud.show({ phase: "message", text: "done" });
    await hud.warm();
    hud.hide();
    expect(h.log.at(-1)).toBe("throttle:true");
    expect(h.windows[0]?.visible).toBe(false);
  });

  it("stays unthrottled while the microphone is open, and throttles only after it is released", async () => {
    const hud = makeHud();
    const started = hud.start().catch(() => undefined);
    await hud.warm();
    expect(h.log.at(-1)).toBe("throttle:false");
    const win = h.windows[0];
    if (!win) throw new Error("no window");
    ack(lastCommand(win).id);
    await started;

    // Hidden while capturing: the HUD stops the microphone first, and only then throttles.
    const mark = h.log.length;
    hud.hide();
    expect(h.log.slice(mark)).not.toContain("throttle:true");
    ack(lastCommand(win).id, false);
    await vi.waitFor(() => expect(h.log.at(-1)).toBe("throttle:true"));
  });

  it("throttles a stopped, hidden HUD once it is hidden", async () => {
    const hud = makeHud();
    hud.show({ phase: "listening", app: "Notes", text: "" });
    const started = hud.start().catch(() => undefined);
    await hud.warm();
    const win = h.windows[0];
    if (!win) throw new Error("no window");
    ack(lastCommand(win).id);
    await started;

    const stopped = hud.stop();
    ack(lastCommand(win).id, false);
    await stopped;
    // Still visible (the owner has not left the HUD yet), so no throttling yet.
    expect(h.log.at(-1)).toBe("throttle:false");
    hud.hide();
    expect(h.log.at(-1)).toBe("throttle:true");
  });
});
