import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../src/lib/ipc.ts";

/** A BrowserWindow that records what main does with it. */
class FakeWindow {
  static all: FakeWindow[] = [];
  readonly sent: [string, unknown][] = [];
  readonly #wcOn = new Map<string, () => void>();
  readonly #on = new Map<string, () => void>();
  loading = true;
  readonly webContents = {
    on: (ev: string, fn: () => void) => this.#wcOn.set(ev, fn),
    send: (channel: string, payload: unknown) => this.sent.push([channel, payload]),
    isLoading: () => this.loading,
    focus: () => undefined,
  };
  destroyed = false;
  visible = false;
  focused = false;
  url = "";
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeWindow.all.push(this);
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  on(ev: string, fn: () => void) {
    this.#on.set(ev, fn);
  }
  once(ev: string, fn: () => void) {
    this.#on.set(ev, fn);
  }
  async loadURL(url: string) {
    this.url = url;
  }
  finishLoad() {
    this.loading = false;
    this.#wcOn.get("did-finish-load")?.();
  }
  ready() {
    this.#on.get("ready-to-show")?.();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  setBounds(b: typeof this.bounds) {
    this.bounds = b;
  }
  getBounds() {
    return this.bounds;
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  focus() {
    this.focused = true;
  }
  destroy() {
    this.destroyed = true;
    this.#on.get("closed")?.();
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
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
      bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
    }),
  },
}));

const { ScreenAskWindow, clampHeight, panelBounds, parseThread, regionRect } = await import(
  "../../src/main/screen-ask/panel.ts"
);
const { voicePopup } = await import("../../src/main/screen-ask/voice-key.ts");

function make() {
  const opened: string[] = [];
  const ask = new ScreenAskWindow({
    url: (route) => `psyche-app://app${route}`,
    preloadPath: "/preload.js",
    onOpenThread: (id) => opened.push(id),
  });
  const live = () => FakeWindow.all.filter((w) => !w.destroyed);
  const send = (channel: string, sender: unknown, arg?: unknown) =>
    handlers.get(channel)?.({ sender }, arg);
  return { ask, opened, live, send };
}

beforeEach(() => {
  FakeWindow.all = [];
  handlers.clear();
});

describe("screen ask helpers", () => {
  it("places the panel top-centre and clamps its height", () => {
    expect(panelBounds({ x: 0, y: 25, width: 1440, height: 875 }, 50)).toEqual({
      x: 440,
      y: 37,
      width: 560,
      height: 72,
    });
    expect(clampHeight(9000)).toBe(560);
    expect(clampHeight("x")).toBe(72);
  });

  it("turns the overlay's box into global points, clipped to the display", () => {
    const display = { x: 1440, y: 0, width: 1920, height: 1080 };
    expect(regionRect({ rect: { x: 10, y: 20, width: 300, height: 200 } }, display)).toEqual({
      x: 1450,
      y: 20,
      width: 300,
      height: 200,
    });
    // Dragged up and left, and past the edge.
    expect(regionRect({ rect: { x: 1900, y: 100, width: 200, height: -50 } }, display)).toEqual({
      x: 3340,
      y: 50,
      width: 20,
      height: 50,
    });
    expect(regionRect({ rect: { x: 0, y: 0, width: 4, height: 400 } }, display)).toBeNull();
    expect(regionRect({ rect: null }, display)).toBeNull();
    expect(regionRect({ rect: { x: "1", y: 0, width: 10, height: 10 } }, display)).toBeNull();
  });

  it("accepts only thread ids", () => {
    expect(parseThread({ threadId: "th_1" })).toBe("th_1");
    expect(parseThread({ threadId: "../x" })).toBeUndefined();
    expect(parseThread(null)).toBeUndefined();
  });
});

describe("ScreenAskWindow", () => {
  it("warms one hidden panel at the ask route, and the trigger shows it with a window capture", () => {
    const { ask, live } = make();
    ask.setEnabled(true);
    expect(live()).toHaveLength(1);
    const panel = live()[0] as FakeWindow;
    expect(panel.url).toBe("psyche-app://app/screen-ask");
    expect(panel.options.type).toBe("panel");
    ask.trigger();
    // Sent once the renderer has loaded.
    expect(panel.sent).toEqual([]);
    panel.finishLoad();
    expect(panel.sent).toEqual([[IPC.screenAskOpen, { mode: "window" }]]);
    expect(panel.visible && panel.focused).toBe(true);
  });

  it("voice mode opens the same panel with no capture, and never starts region select", () => {
    const { ask, live } = make();
    ask.setEnabled(true);
    ask.setEnabled(true, "voice");
    const panel = live()[0] as FakeWindow;
    panel.finishLoad();
    ask.trigger("voice");
    expect(panel.sent).toEqual([[IPC.screenAskOpen, { mode: "voice" }]]);
    ask.trigger("voice");
    expect(live()).toHaveLength(1);
  });

  it("a second trigger while open selects an area; the dragged box goes to the panel", () => {
    const { ask, live, send } = make();
    ask.setEnabled(true);
    const panel = live()[0] as FakeWindow;
    panel.finishLoad();
    ask.trigger();
    ask.trigger();
    const overlay = live()[1] as FakeWindow;
    expect(overlay.url).toBe("psyche-app://app/screen-ask-region");
    overlay.ready();
    expect(overlay.visible).toBe(true);
    // Only the overlay may send the box.
    send(IPC.screenAskRegion, panel.webContents, { rect: { x: 0, y: 0, width: 100, height: 100 } });
    expect(overlay.destroyed).toBe(false);
    send(IPC.screenAskRegion, overlay.webContents, {
      rect: { x: 10, y: 10, width: 100, height: 50 },
    });
    expect(overlay.destroyed).toBe(true);
    expect(panel.sent.at(-1)).toEqual([
      IPC.screenAskOpen,
      { mode: "region", rect: { x: 1450, y: 10, width: 100, height: 50 } },
    ]);
  });

  it("Esc in the overlay keeps the window capture", () => {
    const { ask, live, send } = make();
    ask.setEnabled(true);
    const panel = live()[0] as FakeWindow;
    panel.finishLoad();
    ask.trigger();
    ask.selectArea();
    const overlay = live()[1] as FakeWindow;
    send(IPC.screenAskRegion, overlay.webContents, { rect: null });
    expect(overlay.destroyed).toBe(true);
    expect(panel.sent).toEqual([[IPC.screenAskOpen, { mode: "window" }]]);
  });

  it("done hides, open thread hides and opens, and other senders are ignored", () => {
    const { ask, live, send, opened } = make();
    ask.setEnabled(true);
    const panel = live()[0] as FakeWindow;
    ask.trigger();
    send(IPC.screenAskDone, { other: true });
    expect(panel.visible).toBe(true);
    send(IPC.screenAskOpenThread, panel.webContents, { threadId: "th_9" });
    expect(panel.visible).toBe(false);
    expect(opened).toEqual(["th_9"]);
    ask.trigger();
    send(IPC.screenAskDone, panel.webContents);
    expect(panel.visible).toBe(false);
  });

  it("is off when disabled or suspended", () => {
    const { ask, live } = make();
    ask.trigger();
    expect(live()).toHaveLength(0);
    ask.setEnabled(true);
    ask.suspend();
    expect(live()).toHaveLength(0);
    ask.trigger();
    expect(live()).toHaveLength(0);
    ask.resume();
    expect(live()).toHaveLength(1);
  });

  it("exists while either Ask about screen or Talk with Psyche is on", () => {
    const { ask, live } = make();
    // Voice only: the window is warm and the voice key opens it; screen capture stays off.
    ask.setEnabled(true, "voice");
    expect(live()).toHaveLength(1);
    const panel = live()[0] as FakeWindow;
    panel.finishLoad();
    ask.trigger();
    expect(panel.visible).toBe(false);
    ask.selectArea();
    expect(live()).toHaveLength(1);
    ask.trigger("voice");
    expect(panel.sent).toEqual([[IPC.screenAskOpen, { mode: "voice" }]]);
    expect(panel.visible).toBe(true);
    // Screen on too, then off again: the same window stays for voice.
    ask.setEnabled(true, "screen");
    ask.setEnabled(false, "screen");
    expect(live()).toEqual([panel]);
    expect(ask.enabled("screen")).toBe(false);
    expect(ask.enabled("voice")).toBe(true);
    // Both off: the window goes.
    ask.setEnabled(false, "voice");
    expect(live()).toHaveLength(0);
  });

  it("screen only: the voice key opens nothing", () => {
    const { ask, live } = make();
    ask.setEnabled(true);
    const panel = live()[0] as FakeWindow;
    panel.finishLoad();
    ask.trigger("voice");
    expect(panel.sent).toEqual([]);
    expect(panel.visible).toBe(false);
  });
});

describe("voicePopup", () => {
  it("key down opens voice mode, both edges reach the renderer, and enabled keeps the window", () => {
    const calls: string[] = [];
    const panel = {
      trigger: (mode: "voice") => calls.push(`trigger:${mode}`),
      setEnabled: (on: boolean, source: string) => calls.push(`enabled:${source}:${on}`),
    };
    const keys: boolean[] = [];
    const l = voicePopup(
      () => panel,
      (down) => keys.push(down),
    );
    l.onVoiceEnabled(true);
    l.onVoiceKey(true);
    l.onVoiceKey(false);
    l.onVoiceEnabled(false);
    expect(calls).toEqual(["enabled:voice:true", "trigger:voice", "enabled:voice:false"]);
    expect(keys).toEqual([true, false]);
    // No panel yet (before app ready): the key still reaches the renderers.
    voicePopup(
      () => undefined,
      (down) => keys.push(down),
    ).onVoiceKey(true);
    expect(keys).toEqual([true, false, true]);
  });
});
