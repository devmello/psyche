import { describe, expect, it } from "vitest";
import type { PsycheBridge } from "../../src/preload.ts";
import { desktopPlatform, GatewayCallError, unwrapCall } from "../../src/renderer/bridge.ts";

describe("renderer bridge", () => {
  it("returns the value of an ok envelope", async () => {
    await expect(unwrapCall(Promise.resolve({ ok: true, value: { a: 1 } }))).resolves.toEqual({
      a: 1,
    });
  });

  it("rebuilds Gateway errors with their code and details on the renderer side", async () => {
    const err = await unwrapCall(
      Promise.resolve({
        ok: false,
        error: {
          code: "approval_required",
          message: "Approve the change first",
          details: { approvalId: "ap_1" },
        },
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayCallError);
    expect(err).toMatchObject({
      code: "approval_required",
      message: "Approve the change first",
      details: { approvalId: "ap_1" },
      retryable: false,
    });
  });

  it("hands Settings → About main's app info and Reveal in Finder (#610)", async () => {
    const info = { appVersion: "0.3.0", arch: "arm64", psycheHome: "/Users/owner/.psyche" };
    let revealed = 0;
    const fake = {
      chrome: { titleBar: "native" },
      app: {
        info: async () => info,
        revealHome: async () => {
          revealed += 1;
        },
      },
    } as unknown as PsycheBridge;
    const platform = desktopPlatform(fake);
    await expect(platform.app?.info()).resolves.toBe(info);
    await platform.app?.revealHome();
    expect(revealed).toBe(1);
  });

  it("relays Try it from the Settings window to main (#677)", () => {
    const sent: string[] = [];
    const fake = {
      chrome: { titleBar: "native" },
      windows: { prefillComposer: (text: string) => sent.push(text) },
    } as unknown as PsycheBridge;
    desktopPlatform(fake).windows?.prefillComposer?.("Draft a reply to Sam");
    expect(sent).toEqual(["Draft a reply to Sam"]);
  });
});
