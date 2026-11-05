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
    expect(Object.keys(bridge.app).sort()).toEqual([
      "info",
      "revealHome",
      "uninstall",
      "uninstallPlan",
    ]);
    await bridge.app.info();
    expect(invoke).toHaveBeenLastCalledWith(IPC.appInfo, undefined);
    await bridge.app.revealHome();
    expect(invoke).toHaveBeenLastCalledWith(IPC.appRevealHome, undefined);
  });
});

describe("Open a cited source", () => {
  it("sends one document id on its own channel and resolves the raw envelope", async () => {
    const bridge = exposed.psyche as { sources: { open: (docId: string) => Promise<unknown> } };
    expect(Object.keys(bridge.sources)).toEqual(["open"]);
    const res = await bridge.sources.open("mail:123");
    expect(invoke).toHaveBeenLastCalledWith(IPC.sourceOpen, { docId: "mail:123" });
    // The renderer unwraps the envelope itself (`unwrapCall`), so the error code survives.
    expect(res).toEqual({ ok: true, value: "v" });
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

describe("Run setup again from the Settings window", () => {
  it("asks main to open a route in the main window, fire-and-forget", () => {
    const bridge = exposed.psyche as { windows: { openInMain: (route: string) => void } };
    bridge.windows.openInMain("/onboarding");
    expect(send).toHaveBeenLastCalledWith(IPC.windowOpenInMain, { route: "/onboarding" });
  });
});

describe("Start Psyche Helper from an approval card", () => {
  it("asks main to launch the bundled helper on its own channel", async () => {
    const bridge = exposed.psyche as { helper: { launch: () => Promise<unknown> } };
    await bridge.helper.launch();
    expect(invoke).toHaveBeenLastCalledWith(IPC.helperLaunch, undefined);
  });
});

describe("Touch ID channels (security review, finding 7)", () => {
  it("approve, register and identity go on their own channels, not the generic call relay", async () => {
    const bridge = exposed.psyche as {
      helper: {
        touchIdApprove: (p: unknown) => Promise<unknown>;
        touchIdRegister: () => Promise<unknown>;
        touchIdIdentity: () => Promise<unknown>;
      };
    };
    await bridge.helper.touchIdApprove({ approvalId: "a", answerToken: "t" });
    expect(invoke).toHaveBeenLastCalledWith(IPC.touchIdApprove, {
      approvalId: "a",
      answerToken: "t",
    });
    await bridge.helper.touchIdRegister();
    expect(invoke).toHaveBeenLastCalledWith(IPC.touchIdRegister);
    await bridge.helper.touchIdIdentity();
    expect(invoke).toHaveBeenLastCalledWith(IPC.touchIdIdentity, undefined);
  });
});

describe("Touch ID errors reach the window intact", () => {
  it("approve and register resolve the error envelope instead of throwing across the bridge", async () => {
    const bridge = exposed.psyche as {
      helper: {
        touchIdApprove: (p: unknown) => Promise<unknown>;
        touchIdRegister: () => Promise<unknown>;
      };
    };
    const failed = {
      ok: false,
      error: { code: "unavailable", message: "no key", details: { reason: "no_presence_key" } },
    };
    invoke.mockResolvedValueOnce(failed as never);
    await expect(
      bridge.helper.touchIdApprove({ approvalId: "a", answerToken: "t" }),
    ).resolves.toEqual(failed);
    invoke.mockResolvedValueOnce(failed as never);
    await expect(bridge.helper.touchIdRegister()).resolves.toEqual(failed);
  });
});
