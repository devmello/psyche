import { describe, expect, it, vi } from "vitest";
import {
  checkIdempotencyKey,
  checkPasskeyOptions,
  IPC,
  REMOTE_ONLY_CHANNELS,
  REMOTE_REFUSED_CHANNELS,
} from "../src/lib/ipc.ts";
import { ceremonyScript, PasskeyHost, type WebAuthnWindow } from "../src/main/passkey-host.ts";

/**
 * Passkeys for a remote Gateway (R2): the ceremony runs in a window of the Gateway's own origin,
 * for that Gateway's RP ID only, one at a time, and a cancel is told apart from a failure.
 */

const ORIGIN = "https://studio-mac.tail1234.ts.net";

function fakeWindow(result: unknown, order: string[] = []) {
  const loaded: string[] = [];
  const scripts: string[] = [];
  let closed = 0;
  const win: WebAuthnWindow = {
    load: async (url) => {
      order.push("load");
      loaded.push(url);
    },
    run: async (script) => {
      order.push("run");
      scripts.push(script);
      return typeof result === "function" ? (result as () => unknown)() : result;
    },
    close: () => {
      order.push("close");
      closed += 1;
    },
  };
  return { win, loaded, scripts, closed: () => closed };
}

describe("PasskeyHost", () => {
  it("runs the ceremony in a page of the Gateway's origin and returns the credential", async () => {
    const f = fakeWindow({ ok: true, credential: { id: "cred-1" } });
    const host = new PasskeyHost({ origin: ORIGIN, createWindow: () => f.win });
    const out = await host.get({ rpId: "studio-mac.tail1234.ts.net", challenge: "abc" });
    expect(out).toEqual({ id: "cred-1" });
    expect(f.loaded).toEqual([`${ORIGIN}/healthz`]);
    expect(f.scripts[0]).toContain('"abc"');
    expect(f.closed()).toBe(1);
  });

  it("refuses another site's RP ID, a parent domain included, before opening anything", async () => {
    const f = fakeWindow({ ok: true, credential: {} });
    const create = vi.fn(() => f.win);
    const host = new PasskeyHost({ origin: ORIGIN, createWindow: create });
    for (const rpId of ["evil.example", "tail1234.ts.net", "ts.net"]) {
      await expect(host.get({ rpId, challenge: "c" })).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(
      host.create({ rp: { id: "evil.example", name: "x" }, challenge: "c" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(create).not.toHaveBeenCalled();
  });

  it("is unavailable without https, such as an SSH tunnel to loopback", async () => {
    const host = new PasskeyHost({
      origin: "http://127.0.0.1:4821",
      createWindow: () => fakeWindow({}).win,
    });
    expect(host.available).toBe(false);
    await expect(host.get({ challenge: "c" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("tells a cancelled prompt from a failure, and keeps the DOMException name", async () => {
    const make = (name: string) =>
      new PasskeyHost({
        origin: ORIGIN,
        createWindow: () => fakeWindow({ ok: false, name, message: "m" }).win,
      });
    await expect(make("NotAllowedError").get({ challenge: "c" })).rejects.toMatchObject({
      code: "cancelled",
      details: { name: "NotAllowedError" },
    });
    await expect(make("SecurityError").get({ challenge: "c" })).rejects.toMatchObject({
      code: "forbidden",
      details: { name: "SecurityError" },
    });
  });

  it("allows one prompt at a time and always closes its window", async () => {
    let release: (v: unknown) => void = () => undefined;
    const pending = new Promise((r) => {
      release = r;
    });
    const wins: ReturnType<typeof fakeWindow>[] = [];
    const host = new PasskeyHost({
      origin: ORIGIN,
      createWindow: () => {
        const f = fakeWindow(() => pending);
        wins.push(f);
        return f.win;
      },
    });
    const first = host.get({ challenge: "c" });
    await expect(host.get({ challenge: "c" })).rejects.toMatchObject({ code: "conflict" });
    release({ ok: true, credential: { id: "x" } });
    await first;
    expect(wins).toHaveLength(1);
    expect(wins[0]?.closed()).toBe(1);
    // Free again afterwards.
    release({ ok: true, credential: { id: "y" } });
    await expect(host.get({ challenge: "c" })).resolves.toEqual({ id: "x" });
  });

  it("gives up on a prompt that never finishes", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeWindow(() => new Promise(() => undefined));
      const host = new PasskeyHost({ origin: ORIGIN, createWindow: () => f.win, timeoutMs: 1000 });
      const out = host.get({ challenge: "c" });
      const caught = out.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await caught).toMatchObject({ code: "timeout" });
      expect(f.closed()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("embeds the options as data, not code", () => {
    const evil = { challenge: '"});globalThis.pwned=1;("' };
    const script = ceremonyScript("get", evil);
    expect(script).toContain(JSON.stringify(evil));
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("passkey channels", () => {
  it("exist for remote windows only, and the helper's Touch ID stays refused there", () => {
    expect([...REMOTE_ONLY_CHANNELS].sort()).toEqual([IPC.passkeyCreate, IPC.passkeyGet].sort());
    for (const c of REMOTE_ONLY_CHANNELS) expect(REMOTE_REFUSED_CHANNELS.has(c)).toBe(false);
    expect(REMOTE_REFUSED_CHANNELS.has(IPC.touchIdApprove)).toBe(true);
  });

  it("take a small JSON object and a plain idempotency key", () => {
    expect(() => checkPasskeyOptions(IPC.passkeyGet, "x")).toThrow();
    expect(() => checkPasskeyOptions(IPC.passkeyGet, { a: "x".repeat(20_000) })).toThrow();
    expect(checkPasskeyOptions(IPC.passkeyGet, { challenge: "c" })).toEqual({ challenge: "c" });
    expect(checkIdempotencyKey(undefined)).toBeUndefined();
    expect(checkIdempotencyKey("outbox:7f3a-12")).toBe("outbox:7f3a-12");
    for (const bad of ["", "a b", "x".repeat(129), 7]) expect(() => checkIdempotencyKey(bad)).toThrow();
  });
});
