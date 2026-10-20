import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectSigningPayload,
  type Frame,
  type NodeCapability,
  okRes,
  parseFrame,
  type Receipt,
  type ReqFrame,
  type ResFrame,
  reqFrame,
  serializeFrame,
} from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHelperProvider,
  HELPER_SERVER_ORIGIN,
  type HelperProvider,
} from "../src/capabilities/helper.ts";
import type { CapabilityEntry } from "../src/capabilities/types.ts";
import { createInvocationContext } from "../src/invocation.ts";
import { NdjsonDecoder } from "../src/transports/ndjson.ts";

const MANIFEST: NodeCapability[] = [
  { name: "computer.click", sideEffect: "write", inputSchema: { type: "object" } },
  { name: "notify.subscribe", sideEffect: "read", streaming: true },
  { name: "vault.unlock", sideEffect: "read" },
  { name: "permissions.request", sideEffect: "none" },
  { name: "keychain.set", sideEffect: "write" },
  { name: "keychain.retrieve", sideEffect: "read" },
];

/** A TypeScript stand-in for the Swift mac helper: dials, handshakes, serves node.invoke. */
class FakeHelper {
  readonly socket: Socket;
  readonly frames: Frame[] = [];
  readonly invokes: ReqFrame[] = [];
  readonly cancels: ReqFrame[] = [];
  closed = false;
  #waiters: (() => void)[] = [];
  #next = 0;
  readonly key = generateKeyPairSync("ed25519");

  private constructor(socket: Socket) {
    this.socket = socket;
    const decoder = new NdjsonDecoder();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const frame = parseFrame(line);
        this.frames.push(frame);
        if (frame.type === "req" && frame.method === "node.invoke") {
          this.invokes.push(frame);
          this.send(okRes(frame.id, { accepted: true }));
        }
        if (frame.type === "req" && frame.method === "node.cancel") {
          this.cancels.push(frame);
          this.send(okRes(frame.id, { ok: true }));
        }
      }
      this.#wake();
    });
    socket.on("close", () => {
      this.closed = true;
      this.#wake();
    });
    socket.on("error", () => {});
  }

  static connect(path: string): Promise<FakeHelper> {
    return new Promise((resolve, reject) => {
      const s = createConnection(path);
      s.once("connect", () => resolve(new FakeHelper(s)));
      s.once("error", reject);
    });
  }

  #wake(): void {
    const w = this.#waiters;
    this.#waiters = [];
    for (const f of w) f();
  }

  async until<T>(probe: () => T | undefined, ms = 2_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = probe();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error("timed out waiting for the hub");
      await new Promise<void>((r) => {
        this.#waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  res(id: string): Promise<ResFrame> {
    return this.until(() =>
      this.frames.find((f): f is ResFrame => f.type === "res" && f.id === id),
    );
  }

  send(frame: Frame): void {
    this.socket.write(`${serializeFrame(frame)}\n`);
  }

  request(method: string, params: unknown): Promise<ResFrame> {
    this.#next += 1;
    const id = `h${this.#next}`;
    this.send(reqFrame(id, method, params));
    return this.res(id);
  }

  get publicKey(): string {
    const jwk = this.key.publicKey.export({ format: "jwk" }) as { x: string };
    return jwk.x;
  }

  async handshake(
    secret: string,
    opts: { signingKey?: KeyObject; manifest?: NodeCapability[] } = {},
  ): Promise<{ connect: ResFrame; verify?: ResFrame }> {
    this.send(
      reqFrame("connect", "connect", {
        protocolVersion: { min: 1, max: 1 },
        deviceId: "helper-device-1",
        publicKey: this.publicKey,
        role: "node",
        platform: "macos",
        deviceFamily: "mac-helper",
        name: "Psyche Helper",
        capabilities: opts.manifest ?? MANIFEST,
        handshakeSecret: secret,
      }),
    );
    const connect = await this.res("connect");
    if (!connect.ok) return { connect };
    const challenge = connect.payload as {
      nonce: string;
      serverOrigin: string;
      protocolVersion: number;
    };
    const payload = connectSigningPayload({
      nonce: challenge.nonce,
      platform: "macos",
      deviceFamily: "mac-helper",
      protocolVersion: challenge.protocolVersion,
      serverOrigin: challenge.serverOrigin,
    });
    const signature = sign(null, payload, opts.signingKey ?? this.key.privateKey).toString(
      "base64url",
    );
    this.send(reqFrame("connect.verify", "connect.verify", { nonce: challenge.nonce, signature }));
    return { connect, verify: await this.res("connect.verify") };
  }

  close(): void {
    this.socket.destroy();
  }
}

function receipt(kind: string): Receipt {
  return {
    id: "rcpt_helper_1",
    kind,
    taskId: null,
    toolCallId: null,
    approvalId: "appr_1",
    outcome: "ok",
    summary: "clicked",
    externalRefs: { invocationId: "inv_1" },
    payload: { x: 1 },
    createdAt: new Date().toISOString(),
  };
}

let dir: string;
let hub: HelperProvider;
const helpers: FakeHelper[] = [];

async function secret(): Promise<string> {
  return (await readFile(join(dir, "run", "handshake.secret"), "utf8")).trim();
}

async function paired(): Promise<FakeHelper> {
  const h = await FakeHelper.connect(hub.socketPath);
  helpers.push(h);
  const out = await h.handshake(await secret());
  expect(out.verify?.ok).toBe(true);
  expect(await hub.waitForHelper(1_000)).toBe(true);
  return h;
}

async function entry(name: string): Promise<CapabilityEntry> {
  const e = (await hub.entries()).find((x) => x.manifest.name === name);
  if (!e) throw new Error(`no entry ${name}`);
  return e;
}

beforeEach(async () => {
  // Short path: Unix socket paths are limited to ~104 bytes on macOS.
  dir = await mkdtemp(join(tmpdir(), "phn-"));
  hub = createHelperProvider({ home: dir });
  await hub.start();
});

afterEach(async () => {
  for (const h of helpers.splice(0)) h.close();
  await hub.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe("helper hub handshake", () => {
  it("writes the socket and secret owner-only", async () => {
    expect(hub.socketPath).toBe(join(dir, "run", "node.sock"));
    expect((await stat(hub.socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "run", "handshake.secret"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "run"))).mode & 0o777).toBe(0o700);
    expect((await secret()).length).toBeGreaterThanOrEqual(43);
  });

  it("denies a wrong handshake secret and closes", async () => {
    const h = await FakeHelper.connect(hub.socketPath);
    helpers.push(h);
    const out = await h.handshake("not-the-secret");
    expect(out.connect.ok).toBe(false);
    if (!out.connect.ok) expect(out.connect.error.code).toBe("unauthorized");
    await h.until(() => (h.closed ? true : undefined));
    expect(await hub.entries()).toEqual([]);
  });

  it("denies a bad signature", async () => {
    const h = await FakeHelper.connect(hub.socketPath);
    helpers.push(h);
    const other = generateKeyPairSync("ed25519").privateKey;
    const out = await h.handshake(await secret(), { signingKey: other });
    expect(out.verify?.ok).toBe(true);
    expect((out.verify as { payload: { phase: string } }).payload.phase).toBe("denied");
    await h.until(() => (h.closed ? true : undefined));
    expect((await hub.status?.())?.helper).toBe("absent");
  });

  it("answers not_paired before the handshake", async () => {
    const h = await FakeHelper.connect(hub.socketPath);
    helpers.push(h);
    const res = await h.request("node.result", { invocationId: "x", ok: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_paired");
  });

  it("signs over the local server origin", async () => {
    const h = await FakeHelper.connect(hub.socketPath);
    helpers.push(h);
    const out = await h.handshake(await secret());
    expect((out.connect as { payload: { serverOrigin: string } }).payload.serverOrigin).toBe(
      HELPER_SERVER_ORIGIN,
    );
    expect((out.verify as { payload: unknown }).payload).toMatchObject({
      phase: "paired",
      deviceId: "helper-device-1",
      scopes: ["node"],
      stateVersion: 0,
    });
  });
});

describe("helper hub proxy", () => {
  it("offers computer/apps/notify/speech and non-secret keychain calls, verbatim", async () => {
    const changed = vi.fn();
    hub.onChange?.(changed);
    await paired();
    expect(changed).toHaveBeenCalledTimes(1);
    const entries = await hub.entries();
    expect(entries.map((e) => e.manifest)).toEqual([MANIFEST[0], MANIFEST[1], MANIFEST[4]]);
    expect(await hub.status?.()).toEqual({ helper: "connected", capabilities: 3 });
  });

  it("proxies params and passes approvalId through only when set", async () => {
    const h = await paired();
    const click = await entry("computer.click");

    const ctx1 = createInvocationContext({
      invocationId: "inv_1",
      capability: "computer.click",
      approvalId: "appr_1",
    });
    const p1 = click.handler({ ref: "ax_3" }, ctx1);
    const inv1 = await h.until(() => h.invokes[0]);
    expect(inv1.params).toEqual({
      invocationId: "inv_1",
      capability: "computer.click",
      params: { ref: "ax_3" },
      approvalId: "appr_1",
    });
    const rcpt = receipt("computer.click");
    await h.request("node.result", {
      invocationId: "inv_1",
      ok: true,
      result: { clicked: true },
      receipt: rcpt,
    });
    expect(await p1).toEqual({ ok: true, result: { clicked: true }, receipt: rcpt });

    const ctx2 = createInvocationContext({ invocationId: "inv_2", capability: "computer.click" });
    const p2 = click.handler({ ref: "ax_4" }, ctx2);
    const inv2 = await h.until(() => h.invokes[1]);
    expect(inv2.params).not.toHaveProperty("approvalId");
    await h.request("node.result", {
      invocationId: "inv_2",
      ok: false,
      error: { code: "forbidden", message: "Accessibility not granted" },
    });
    expect(await p2).toEqual({
      ok: false,
      error: { code: "forbidden", message: "Accessibility not granted" },
    });
  });

  it("streams helper events in order and acknowledges them", async () => {
    const h = await paired();
    const sub = await entry("notify.subscribe");
    const seen: unknown[] = [];
    const ctx = createInvocationContext({
      invocationId: "inv_s",
      capability: "notify.subscribe",
      emit: (d) => seen.push(d),
    });
    const p = sub.handler({}, ctx);
    await h.until(() => h.invokes[0]);
    for (const n of [1, 2, 3]) {
      const ack = await h.request("node.event", { invocationId: "inv_s", data: { n } });
      expect(ack).toMatchObject({ ok: true, payload: { ok: true } });
    }
    await h.request("node.result", { invocationId: "inv_s", ok: true });
    expect(await p).toEqual({ ok: true });
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("sends node.cancel on abort and takes the helper's result", async () => {
    const h = await paired();
    const click = await entry("computer.click");
    const ac = new AbortController();
    const ctx = createInvocationContext({
      invocationId: "inv_c",
      capability: "computer.click",
      signal: ac.signal,
    });
    const p = click.handler({}, ctx);
    await h.until(() => h.invokes[0]);
    ac.abort();
    const cancel = await h.until(() => h.cancels[0]);
    expect(cancel.params).toEqual({ invocationId: "inv_c" });
    await h.request("node.result", {
      invocationId: "inv_c",
      ok: false,
      error: { code: "cancelled", message: "cancelled" },
    });
    expect(await p).toEqual({ ok: false, error: { code: "cancelled", message: "cancelled" } });
  });

  it("resolves cancelled when the helper ignores node.cancel", async () => {
    const h = await paired();
    const click = await entry("computer.click");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const ac = new AbortController();
      const ctx = createInvocationContext({
        invocationId: "inv_t",
        capability: "computer.click",
        signal: ac.signal,
      });
      const p = click.handler({}, ctx);
      ac.abort();
      vi.advanceTimersByTime(5_001);
      expect(await p).toMatchObject({ ok: false, error: { code: "cancelled" } });
    } finally {
      vi.useRealTimers();
    }
    expect(h.closed).toBe(false);
  });

  it("fails in-flight with unavailable when the helper disconnects", async () => {
    const h = await paired();
    const changed = vi.fn();
    hub.onChange?.(changed);
    const click = await entry("computer.click");
    const p = click.handler(
      {},
      createInvocationContext({ invocationId: "inv_d", capability: "computer.click" }),
    );
    await h.until(() => h.invokes[0]);
    h.close();
    expect(await p).toEqual({
      ok: false,
      error: { code: "unavailable", message: "mac helper disconnected" },
    });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(await hub.entries()).toEqual([]);
    expect(await hub.status?.()).toEqual({ helper: "absent", capabilities: 0 });
  });

  it("returns the helper's error res for node.invoke", async () => {
    const h = await paired();
    const click = await entry("computer.click");
    // Make the fake helper refuse: intercept by answering before the auto-accept is read.
    h.socket.removeAllListeners("data");
    const decoder = new NdjsonDecoder();
    h.socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const f = parseFrame(line);
        if (f.type === "req" && f.method === "node.invoke") {
          h.send({
            type: "res",
            id: f.id,
            ok: false,
            error: { code: "not_found", message: "Unknown capability" },
          });
        }
      }
    });
    const out = await click.handler(
      {},
      createInvocationContext({ invocationId: "inv_e", capability: "computer.click" }),
    );
    expect(out).toEqual({ ok: false, error: { code: "not_found", message: "Unknown capability" } });
  });

  it("a new helper replaces the old one", async () => {
    const first = await paired();
    const click = await entry("computer.click");
    const p = click.handler(
      {},
      createInvocationContext({ invocationId: "inv_r", capability: "computer.click" }),
    );
    await first.until(() => first.invokes[0]);
    await paired();
    expect(await p).toMatchObject({ ok: false, error: { code: "unavailable" } });
    await first.until(() => (first.closed ? true : undefined));
    expect((await hub.entries()).length).toBe(3);
  });

  it("dispose removes the socket file", async () => {
    await paired();
    await hub.dispose();
    await expect(stat(hub.socketPath)).rejects.toThrow();
  });
});
