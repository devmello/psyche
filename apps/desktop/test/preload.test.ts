import { beforeAll, describe, expect, it, vi } from "vitest";
import { IPC } from "../src/lib/ipc.ts";

const exposed: Record<string, unknown> = {};
const invoke = vi.fn(async (_channel: string, _arg?: unknown) => ({ ok: true, value: "v" }));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      exposed[key] = api;
    },
  },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
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
