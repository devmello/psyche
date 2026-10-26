import { beforeAll, describe, expect, it, vi } from "vitest";
import { IPC } from "../src/lib/ipc.ts";

const exposed: Record<string, unknown> = {};
const invoke = vi.fn(async (_channel: string, _arg?: unknown) => ({ ok: true, value: "v" }));
const send = vi.fn();

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      exposed[key] = api;
    },
  },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn(), send },
}));

beforeAll(async () => {
  await import("../src/preload.ts");
});

describe("the preload bridge (#610)", () => {
  it("exposes About's app info and Reveal in Finder over their own channels", async () => {
    const bridge = exposed.psyche as {
      app: { info: () => Promise<unknown>; revealHome: () => Promise<unknown> };
    };
    expect(Object.keys(bridge.app).sort()).toEqual(["info", "revealHome"]);
    await bridge.app.info();
    expect(invoke).toHaveBeenLastCalledWith(IPC.appInfo, undefined);
    await bridge.app.revealHome();
    expect(invoke).toHaveBeenLastCalledWith(IPC.appRevealHome, undefined);
  });
});

describe("Try it from the Settings window (#677)", () => {
  it("sends the composer text to main on its own channel, fire-and-forget", () => {
    const bridge = exposed.psyche as { windows: { prefillComposer: (text: string) => void } };
    bridge.windows.prefillComposer("What's on my calendar today?");
    expect(send).toHaveBeenLastCalledWith(IPC.windowPrefillComposer, {
      text: "What's on my calendar today?",
    });
  });
});

describe("the voice HUD bridge (V-G)", () => {
  it("sends done and openThread to main on their own channels", () => {
    const bridge = exposed.psyche as {
      voiceHud: { done: () => void; openThread: (id: string | null) => void };
    };
    expect(Object.keys(bridge.voiceHud).sort()).toEqual(["done", "openThread"]);
    bridge.voiceHud.done();
    expect(send).toHaveBeenLastCalledWith(IPC.voiceHudDone);
    bridge.voiceHud.openThread("th_1");
    expect(send).toHaveBeenLastCalledWith(IPC.voiceHudOpenThread, { threadId: "th_1" });
    bridge.voiceHud.openThread(null);
    expect(send).toHaveBeenLastCalledWith(IPC.voiceHudOpenThread, { threadId: null });
  });
});
