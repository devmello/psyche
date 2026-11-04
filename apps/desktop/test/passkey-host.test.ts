import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  checkIdempotencyKey,
  checkPasskeyOptions,
  IPC,
  REMOTE_ONLY_CHANNELS,
  REMOTE_REFUSED_CHANNELS,
} from "../src/lib/ipc.ts";
import {
  ceremonyScript,
  PASSKEY_PAGE_PATH,
  PasskeyHost,
  type WebAuthnWindow,
} from "../src/main/passkey-host.ts";

/**
 * Passkeys for a remote Gateway (R2): the ceremony runs in a window of the Gateway's own origin,
 * for that Gateway's RP ID only, one at a time; a cancel is told apart from a failure; and main
 * checks the credential the page returns before the renderer sees it.
 */

const HOST = "studio-mac.tail1234.ts.net";
const ORIGIN = `https://${HOST}`;
const PAGE = `${ORIGIN}${PASSKEY_PAGE_PATH}`;
const CHALLENGE = "Y2hhbGxlbmdl";

const getOptions = (over: Record<string, unknown> = {}) => ({
  rpId: HOST,
  challenge: CHALLENGE,
  ...over,
});

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** What `credential.toJSON()` would give, made for `over`'s origin, challenge, type and RP ID. */
function credential(
  kind: "create" | "get" = "get",
  over: { origin?: string; challenge?: string; type?: string; rpId?: string } = {},
) {
  const client = {
    type: over.type ?? (kind === "create" ? "webauthn.create" : "webauthn.get"),
    challenge: over.challenge ?? CHALLENGE,
    origin: over.origin ?? ORIGIN,
  };
  const auth = Buffer.concat([
    createHash("sha256")
      .update(over.rpId ?? HOST)
      .digest(),
    Buffer.from([0x05, 0, 0, 0, 1]),
  ]);
  return {
    id: "cred-1",
    response: {
      clientDataJSON: b64u(JSON.stringify(client)),
      authenticatorData: b64u(auth),
    },
  };
}

function fakeWindow(result: unknown, opts: { finalUrl?: string } = {}) {
  const loaded: string[] = [];
  const scripts: string[] = [];
  let closed = 0;
  const win: WebAuthnWindow = {
    load: async (url) => {
      loaded.push(url);
    },
    currentUrl: () => opts.finalUrl ?? loaded.at(-1) ?? "",
    run: async (script) => {
      scripts.push(script);
      return typeof result === "function" ? (result as () => unknown)() : result;
    },
    close: () => {
      closed += 1;
    },
  };
  return { win, loaded, scripts, closed: () => closed };
}

const host = (f: ReturnType<typeof fakeWindow>, o: { origin?: string } = {}) =>
  new PasskeyHost({ origin: o.origin ?? ORIGIN, createWindow: () => f.win });

describe("PasskeyHost", () => {
  it("runs the ceremony on the window's own page of the Gateway's origin and returns the credential", async () => {
    const cred = credential();
    const f = fakeWindow({ ok: true, credential: cred });
    const out = await host(f).get(getOptions());
    expect(out).toEqual(cred);
    // Never the Host's own content: a path main serves itself.
    expect(f.loaded).toEqual([PAGE]);
    expect(f.scripts[0]).toContain(JSON.stringify(CHALLENGE));
    expect(f.closed()).toBe(1);
  });

  it("verifies a registration the same way", async () => {
    const opts = { rp: { id: HOST, name: "Psyche" }, challenge: CHALLENGE };
    const f = fakeWindow({ ok: true, credential: credential("create") });
    await expect(host(f).create(opts)).resolves.toBeDefined();
  });

  it("refuses another site's RP ID, a parent domain included, before opening anything", async () => {
    const f = fakeWindow({ ok: true, credential: credential() });
    const create = vi.fn(() => f.win);
    const h = new PasskeyHost({ origin: ORIGIN, createWindow: create });
    for (const rpId of ["evil.example", "tail1234.ts.net", "ts.net"]) {
      await expect(h.get(getOptions({ rpId }))).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(
      h.create({ rp: { id: "evil.example", name: "x" }, challenge: CHALLENGE }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses options that name no RP ID (the page would pick its own), or no challenge", async () => {
    const create = vi.fn(() => fakeWindow({}).win);
    const h = new PasskeyHost({ origin: ORIGIN, createWindow: create });
    await expect(h.get({ challenge: CHALLENGE })).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.create({ rp: { name: "x" }, challenge: CHALLENGE })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(h.get({ rpId: HOST })).rejects.toMatchObject({ code: "invalid_params" });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses when the window ended up anywhere but the page (a redirect)", async () => {
    const f = fakeWindow(
      { ok: true, credential: credential() },
      { finalUrl: "https://github.com/login" },
    );
    await expect(host(f).get(getOptions())).rejects.toMatchObject({ code: "forbidden" });
    expect(f.scripts).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  it("refuses a credential made for another origin, challenge, type or RP ID", async () => {
    const refuse = async (c: unknown) => {
      const f = fakeWindow({ ok: true, credential: c });
      await expect(host(f).get(getOptions())).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("not made for this Gateway"),
      });
      expect(f.closed()).toBe(1);
    };
    await refuse(credential("get", { origin: "https://github.com" }));
    await refuse(credential("get", { challenge: "b3RoZXI" }));
    await refuse(credential("get", { type: "webauthn.create" }));
    await refuse(credential("get", { rpId: "ts.net" }));
    await refuse({ id: "x" });
    await refuse({ id: "x", response: { clientDataJSON: "!!", authenticatorData: "AA" } });
    // A registration is not a sign-in.
    const f = fakeWindow({ ok: true, credential: credential("create") });
    await expect(host(f).get(getOptions())).rejects.toMatchObject({ code: "forbidden" });
  });

  it("is unavailable without https, such as an SSH tunnel to loopback", async () => {
    const h = new PasskeyHost({
      origin: "http://127.0.0.1:4821",
      createWindow: () => fakeWindow({}).win,
    });
    expect(h.available).toBe(false);
    await expect(h.get(getOptions({ rpId: "127.0.0.1" }))).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("tells a cancelled prompt from a failure, and keeps the DOMException name", async () => {
    const make = (name: string) =>
      host(fakeWindow({ ok: false, name, message: "m" }));
    await expect(make("NotAllowedError").get(getOptions())).rejects.toMatchObject({
      code: "cancelled",
      details: { name: "NotAllowedError" },
    });
    await expect(make("SecurityError").get(getOptions())).rejects.toMatchObject({
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
    const h = new PasskeyHost({
      origin: ORIGIN,
      createWindow: () => {
        const f = fakeWindow(() => pending);
        wins.push(f);
        return f.win;
      },
    });
    const first = h.get(getOptions());
    await expect(h.get(getOptions())).rejects.toMatchObject({ code: "conflict" });
    release({ ok: true, credential: credential() });
    await first;
    expect(wins).toHaveLength(1);
    expect(wins[0]?.closed()).toBe(1);
  });

  it("gives up on a prompt that never finishes", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeWindow(() => new Promise(() => undefined));
      const h = new PasskeyHost({ origin: ORIGIN, createWindow: () => f.win, timeoutMs: 1000 });
      const caught = h.get(getOptions()).catch((e: unknown) => e);
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
    for (const bad of ["", "a b", "x".repeat(129), 7])
      expect(() => checkIdempotencyKey(bad)).toThrow();
  });
});
