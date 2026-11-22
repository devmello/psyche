import { describe, expect, it } from "vitest";
import type { PsycheBridge } from "../../src/preload.ts";
import {
  desktopPlatform,
  GatewayCallError,
  remoteClientPlatform,
  unwrapCall,
} from "../../src/renderer/bridge.ts";

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

  it("on Linux offers the password path and no Touch ID, so Allow reaches approveWithPassword", async () => {
    const sent: unknown[] = [];
    const ok = { ok: true, value: { approval: { id: "ap_1" } } };
    const mk = (platform: string) =>
      ({
        platform,
        chrome: { titleBar: "native" },
        helper: { touchIdApprove: async () => ok, touchIdRegister: async () => ok },
        password: {
          approve: async (p: unknown) => {
            sent.push(p);
            return ok;
          },
        },
      }) as unknown as PsycheBridge;
    const linux = desktopPlatform(mk("linux"));
    expect(linux.helper?.touchId).toBeUndefined();
    expect(linux.helper).toBeDefined();
    await linux.password?.approve({ approvalId: "ap_1", answerToken: "t" });
    expect(sent).toEqual([{ approvalId: "ap_1", answerToken: "t" }]);
    // A window on another computer's Gateway has no password dialog of its own to promise.
    expect(remoteClientPlatform(linux).password).toBeUndefined();
    const mac = desktopPlatform(mk("darwin"));
    expect(mac.helper?.touchId).toBeDefined();
    expect(mac.password).toBeUndefined();
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
    await platform.app?.revealHome?.();
    expect(revealed).toBe(1);
  });

  it("offers Uninstall only when main says this copy can uninstall itself (packaged, own agent)", () => {
    const app = {
      info: async () => ({}),
      uninstallPlan: async () => ({}),
      uninstall: async () => ({ ok: true }),
    };
    const dev = desktopPlatform({ chrome: { titleBar: "native" }, app } as unknown as PsycheBridge);
    expect(dev.app?.uninstall).toBeUndefined();
    expect(dev.app?.uninstallPlan).toBeUndefined();
    const packaged = desktopPlatform({
      chrome: { titleBar: "native", uninstall: true },
      app,
    } as unknown as PsycheBridge);
    expect(packaged.app?.uninstall).toBeDefined();
    // A remote window never gets it, whatever the flag says.
    const remote = desktopPlatform({
      chrome: { titleBar: "native", uninstall: true, remote: { hostName: "studio" } },
      app,
    } as unknown as PsycheBridge);
    expect(remote.app?.uninstall).toBeUndefined();
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
  describe("a client of a Gateway on another computer (remote-gateway design §4.2)", () => {
    const remote = {
      chrome: { titleBar: "native", remote: { hostName: "studio-mac" } },
      app: { info: async () => ({ appVersion: "1" }), revealHome: async () => {} },
      gateway: { showLogs: async () => {}, retry: async () => {} },
    } as unknown as PsycheBridge;

    it("leaves out what only works on the machine the Gateway runs on", () => {
      const platform = desktopPlatform(remote);
      // The agent's browser, the folder picker, the Mac helper with its Touch ID, system-wide
      // dictation, and revealing the Host's folders or logs.
      expect(platform.browser).toBeUndefined();
      expect(platform.dialogs).toBeUndefined();
      expect(platform.helper).toBeUndefined();
      expect(platform.dictation).toBeUndefined();
      // The local terminal starts a process from what the Gateway answers: never for a remote
      // one. The pane gets a session on the Host instead (below).
      expect(platform.sources).toBeUndefined();
      expect(platform.permissions).toBeUndefined();
      expect(platform.app?.revealHome).toBeUndefined();
      expect(platform.gateway.showLogs).toBeUndefined();
      // The window is told whose it is, and the shell, the terminal and the switcher stay.
      expect(platform.chrome?.remote).toEqual({ hostName: "studio-mac" });
      expect(platform.gateways).toBeDefined();
      expect(platform.gateway.retry).toBeDefined();
      expect(platform.app?.info).toBeDefined();
    });

    it("offers passkeys for the Host's Gateway, with this window's device id", async () => {
      const calls: string[] = [];
      const bridge = {
        ...remote,
        gateway: { deviceId: async () => "dev-1" },
        passkeys: {
          create: async () => ({ ok: true, value: { id: "made" } }),
          get: async () => {
            calls.push("get");
            return {
              ok: false,
              error: {
                code: "cancelled",
                message: "cancelled",
                details: { name: "NotAllowedError" },
              },
            };
          },
        },
      } as unknown as PsycheBridge;
      const passkeys = desktopPlatform(bridge).passkeys;
      expect(await passkeys?.deviceId()).toBe("dev-1");
      expect(await passkeys?.authenticator.create({ challenge: "c" })).toEqual({ id: "made" });
      // A cancelled sheet keeps its DOMException name, so the web client's wording applies.
      await expect(passkeys?.authenticator.get({ challenge: "c" })).rejects.toMatchObject({
        name: "NotAllowedError",
      });
      expect(calls).toEqual(["get"]);
    });

    it("keeps no passkeys for This Mac, which has the helper's Touch ID", () => {
      const platform = desktopPlatform({
        ...remote,
        chrome: { titleBar: "native" },
      } as unknown as PsycheBridge);
      expect(platform.passkeys).toBeUndefined();
    });

    it("sends a call's idempotency key through to main", async () => {
      const seen: unknown[][] = [];
      const bridge = {
        chrome: { titleBar: "native" },
        gateway: {
          call: async (...args: unknown[]) => {
            seen.push(args);
            return { ok: true, value: {} };
          },
        },
      } as unknown as PsycheBridge;
      const { call } = desktopPlatform(bridge).gateway;
      await call("chat.send", { threadId: "t" }, { idempotencyKey: "outbox:1" });
      await call("threads.list", {});
      expect(seen[0]).toEqual(["chat.send", { threadId: "t" }, "outbox:1"]);
      expect(seen[1]?.[2]).toBeUndefined();
    });

    it("gives the terminal a session on the Host and never main's local PTY", async () => {
      const calls: Array<{ method: string; params: unknown }> = [];
      const local = {
        open: async () => {
          throw new Error("the local terminal must not be used in a remote window");
        },
        write: () => {
          throw new Error("the local terminal must not be used in a remote window");
        },
      };
      const bridge = {
        ...remote,
        terminal: local,
        gateway: {
          ...(remote as unknown as { gateway: object }).gateway,
          call: async (method: string, params: unknown) => {
            calls.push({ method, params });
            return { ok: true, value: { sessionId: "term_1", target: "host", label: "zsh · ~" } };
          },
          onEvent: () => () => undefined,
          onResync: () => () => undefined,
        },
      } as unknown as PsycheBridge;
      const terminal = desktopPlatform(bridge).terminal;
      expect(terminal).toBeDefined();
      const opened = await terminal?.open({ cols: 80, rows: 24, cwd: "/Users/me/code" });
      expect(opened).toEqual({ sessionId: "term_1", target: "host", label: "zsh · ~" });
      expect(calls).toEqual([
        {
          method: "terminal.session.open",
          params: { cols: 80, rows: 24, cwd: "/Users/me/code" },
        },
      ]);
    });

    it("keeps everything for This Mac", () => {
      const platform = desktopPlatform({
        ...remote,
        chrome: { titleBar: "native" },
      } as unknown as PsycheBridge);
      expect(platform.browser).toBeDefined();
      expect(platform.dialogs).toBeDefined();
      expect(platform.helper).toBeDefined();
      expect(platform.dictation).toBeDefined();
      expect(platform.terminal).toBeDefined();
      expect(platform.app?.revealHome).toBeDefined();
    });

    it("opens This Mac's terminal as a Host session too: main never spawns from Gateway data", async () => {
      const calls: string[] = [];
      const bridge = {
        chrome: { titleBar: "native" },
        gateway: {
          call: async (method: string) => {
            calls.push(method);
            return { ok: true, value: { sessionId: "term_9", target: "host", label: "zsh · ~" } };
          },
          onEvent: () => () => undefined,
          onResync: () => () => undefined,
        },
        // There is no local terminal channel any more.
      } as unknown as PsycheBridge;
      expect((bridge as unknown as { terminal?: unknown }).terminal).toBeUndefined();
      const opened = await desktopPlatform(bridge).terminal?.open({ cols: 80, rows: 24 });
      expect(opened).toEqual({ sessionId: "term_9", target: "host", label: "zsh · ~" });
      expect(calls).toEqual(["terminal.session.open"]);
    });
  });
});
