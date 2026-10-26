import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../src/lib/ipc.ts";

/** A BrowserWindow that records what main does with it. */
class FakeWindow {
  static all: FakeWindow[] = [];
  readonly webContents = { on: vi.fn((ev: string, fn: () => void) => this.#on.set(ev, fn)) };
  readonly #on = new Map<string, () => void>();
  readonly #winOn = new Map<string, () => void>();
  destroyed = false;
  visible = false;
  url = "";
  bounds: unknown;
  readonly options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeWindow.all.push(this);
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  on(ev: string, fn: () => void) {
    this.#winOn.set(ev, fn);
  }
  async loadURL(url: string) {
    this.url = url;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  setBounds(b: unknown) {
    this.bounds = b;
  }
  showInactive() {
    this.visible = true;
  }
  destroy() {
    this.destroyed = true;
    this.#winOn.get("closed")?.();
  }
  crash() {
    this.#on.get("render-process-gone")?.();
  }
}

const handlers = new Map<string, (e: { sender: unknown }, arg?: unknown) => void>();
vi.mock("electron", () => ({
  BrowserWindow: FakeWindow,
  ipcMain: {
    on: (channel: string, fn: (e: { sender: unknown }, arg?: unknown) => void) =>
      handlers.set(channel, fn),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }),
  },
}));

const { VoiceHudWindow, parseOpenThread, threadRoute, voiceHudRoute } = await import(
  "../../src/main/voice/hud.ts"
);

function make() {
  const opened: (string | null)[] = [];
  const hud = new VoiceHudWindow({
    url: (route) => `psyche-app://app${route}`,
    preloadPath: "/preload.js",
    onOpenThread: (id) => opened.push(id),
  });
  const live = () => FakeWindow.all.filter((w) => !w.destroyed);
  const send = (channel: string, sender: unknown, arg?: unknown) =>
    handlers.get(channel)?.({ sender }, arg);
  return { hud, opened, live, send };
}

beforeEach(() => {
  FakeWindow.all = [];
  handlers.clear();
});

describe("the voice HUD window (V-G, docs/voice/voice-mode-2026.md §6.2)", () => {
  it("keeps a warm, hidden window only while voice conversation is on", () => {
    const { hud, live } = make();
    hud.show();
    expect(FakeWindow.all).toHaveLength(0);
    hud.setEnabled(true);
    expect(live()).toHaveLength(1);
    const [win] = live();
    expect(win?.url).toBe("psyche-app://app/voice-hud");
    expect(win?.visible).toBe(false);
    expect(win?.options).toMatchObject({ focusable: false, type: "panel", show: false });
    expect(win?.options.webPreferences).toMatchObject({
      preload: "/preload.js",
      contextIsolation: true,
      sandbox: true,
    });
    hud.setEnabled(false);
    expect(live()).toHaveLength(0);
  });

  it("shows the warm window on the voice key, top-centre, without taking focus", () => {
    const { hud, live } = make();
    hud.setEnabled(true);
    hud.show();
    const [win] = live();
    expect(win?.visible).toBe(true);
    expect(win?.bounds).toEqual({ x: 530, y: 37, width: 380, height: 96 });
    expect(hud.owns(win?.webContents as never)).toBe(true);
    expect(hud.contents()).toBe(win?.webContents);
    hud.show();
    expect(FakeWindow.all).toHaveLength(1);
  });

  it("destroys the window on done (freeing the mic) and warms a fresh one", () => {
    const { hud, live, send } = make();
    hud.setEnabled(true);
    hud.show();
    const [first] = live();
    // Another renderer can't end the HUD.
    send(IPC.voiceHudDone, { other: true });
    expect(first?.destroyed).toBe(false);
    send(IPC.voiceHudDone, first?.webContents);
    expect(first?.destroyed).toBe(true);
    expect(live()).toHaveLength(1);
    expect(live()[0]?.visible).toBe(false);
  });

  it("opens the thread in the main window, from the HUD only, with a checked id", () => {
    const { hud, live, send, opened } = make();
    hud.setEnabled(true);
    hud.show();
    const [win] = live();
    send(IPC.voiceHudOpenThread, { other: true }, { threadId: "th_1" });
    send(IPC.voiceHudOpenThread, win?.webContents, { threadId: "../settings" });
    expect(opened).toEqual([]);
    expect(win?.destroyed).toBe(false);
    send(IPC.voiceHudOpenThread, win?.webContents, { threadId: "th_1" });
    expect(opened).toEqual(["th_1"]);
    expect(win?.destroyed).toBe(true);
    send(IPC.voiceHudOpenThread, live()[0]?.webContents, { threadId: null });
    expect(opened).toEqual(["th_1", null]);
  });

  it("keeps no window while the Mac is locked or asleep, and replaces a crashed one", () => {
    const { hud, live } = make();
    hud.setEnabled(true);
    hud.show();
    hud.suspend();
    expect(live()).toHaveLength(0);
    hud.show();
    expect(live()).toHaveLength(0);
    hud.resume();
    expect(live()).toHaveLength(1);
    const [win] = live();
    win?.crash();
    expect(win?.destroyed).toBe(true);
    expect(live()).toHaveLength(1);
  });

  it("builds the routes and parses the thread payload", () => {
    expect(voiceHudRoute()).toBe("/voice-hud");
    expect(voiceHudRoute("th a")).toBe("/voice-hud?thread=th%20a");
    expect(threadRoute(null)).toBe("/chat");
    expect(threadRoute("th_1")).toBe("/chat/th_1");
    expect(parseOpenThread({ threadId: null })).toBeNull();
    expect(parseOpenThread({ threadId: "th_1" })).toBe("th_1");
    expect(parseOpenThread({ threadId: 3 })).toBeUndefined();
    expect(parseOpenThread(null)).toBeUndefined();
    expect(parseOpenThread({ threadId: "a/b" })).toBeUndefined();
  });
});
