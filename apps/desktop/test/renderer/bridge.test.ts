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

  it("keeps a Touch ID failure's reason so the approval card can offer the fix", async () => {
    const noKey = {
      ok: false,
      error: {
        code: "unavailable",
        message: "Touch ID is not set up for approvals",
        details: { reason: "no_presence_key" },
      },
    };
    const fake = {
      chrome: { titleBar: "native" },
      helper: { touchIdApprove: async () => noKey, touchIdRegister: async () => noKey },
    } as unknown as PsycheBridge;
    const touchId = desktopPlatform(fake).helper?.touchId;
    for (const call of [
      () => touchId?.approve({ approvalId: "ap_1", answerToken: "t" }),
      () => touchId?.register(),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: "unavailable",
        details: { reason: "no_presence_key" },
      });
    }
  });

  it("opens a cited source by document id and keeps the error code when main refuses", async () => {
    const sent: string[] = [];
    const fake = {
      chrome: { titleBar: "native" },
      sources: {
        open: async (docId: string) => {
          sent.push(docId);
          return docId === "mail:gone"
            ? { ok: false, error: { code: "not_found", message: "no such source passage" } }
            : { ok: true, value: "mail" };
        },
      },
    } as unknown as PsycheBridge;
    const sources = desktopPlatform(fake).sources;
    await expect(sources?.open("mail:1")).resolves.toBe("mail");
    await expect(sources?.open("mail:gone")).rejects.toMatchObject({ code: "not_found" });
    expect(sent).toEqual(["mail:1", "mail:gone"]);
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

  it("relays Run setup again from the Settings window to main", () => {
    const sent: string[] = [];
    const fake = {
      chrome: { titleBar: "native" },
      windows: { openInMain: (route: string) => sent.push(route) },
    } as unknown as PsycheBridge;
    desktopPlatform(fake).windows?.openInMain?.("/onboarding");
    expect(sent).toEqual(["/onboarding"]);
  });
});
