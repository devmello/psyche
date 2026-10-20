import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { PsycheError } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayConnection, type GatewayEvent } from "../../src/client/connection.ts";
import type { GatewayStatus } from "../../src/client/status.ts";
import { MockGateway } from "../../testing/mock-gateway.ts";

function nodeKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { x: string };
  const key = createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" }));
  return {
    publicKey: jwk.x,
    sign: (p: Uint8Array) => sign(null, p, key).toString("base64url"),
  };
}

async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let gw: MockGateway;
let conn: GatewayConnection | undefined;

afterEach(async () => {
  conn?.stop();
  conn = undefined;
  await gw?.stop();
});

function connect(opts: Partial<ConstructorParameters<typeof GatewayConnection>[0]> = {}) {
  const key = nodeKey();
  const statuses: GatewayStatus[] = [];
  const events: GatewayEvent[] = [];
  let resyncs = 0;
  conn = new GatewayConnection({
    wsUrl: gw.wsUrl,
    healthUrl: `${gw.origin}/healthz`,
    connectParams: () => ({
      protocolVersion: { min: 1, max: 1 },
      deviceId: "dev_test",
      publicKey: key.publicKey,
      role: "client",
      platform: "web",
      deviceFamily: "web",
      name: "test",
    }),
    sign: key.sign,
    onStatus: (s) => statuses.push(s),
    onEvent: (e) => events.push(e),
    onResync: () => resyncs++,
    random: () => 0,
    ...opts,
  });
  conn.start();
  return { statuses, events, resyncs: () => resyncs };
}

describe("GatewayConnection", () => {
  it("pairs, calls methods and receives validated events", async () => {
    gw = await new MockGateway({
      handlers: { "threads.list": () => ({ threads: [], nextCursor: null }) },
    }).start();
    const { statuses, events } = connect();
    await until(() => conn?.isPaired() === true);
    expect(statuses.at(-1)?.phase).toBe("paired");
    expect(statuses.some((s) => s.health === "ok")).toBe(true);

    await expect(conn?.call("threads.list", {})).resolves.toEqual({
      threads: [],
      nextCursor: null,
    });

    gw.emit("gateway.shutdown", { reason: "test" });
    gw.emit("gateway.shutdown", { bogus: true }); // invalid payload for a known event: dropped
    gw.emit("x.future", { anything: 1 }); // unknown events pass through
    await until(() => events.length === 2);
    expect(events.map((e) => e.event)).toEqual(["gateway.shutdown", "x.future"]);
  });

  it("accepts calls from a status listener the moment it hears paired", async () => {
    gw = await new MockGateway({
      handlers: { "memory.read": () => ({ content: "---\nname: Wren\n---\n", etag: "e1" }) },
    }).start();
    const calls: Promise<unknown>[] = [];
    connect({
      onStatus: (s) => {
        if (s.phase === "paired")
          calls.push(conn?.call("memory.read", { path: "IDENTITY.md" }) as Promise<unknown>);
      },
    });
    await until(() => calls.length === 1);
    await expect(calls[0]).resolves.toMatchObject({ etag: "e1" });
  });

  it("adds an idempotency key to side-effecting methods", async () => {
    gw = await new MockGateway({
      handlers: { "threads.create": () => ({ thread: null }) },
    }).start();
    connect();
    await until(() => conn?.isPaired() === true);
    await conn?.call("threads.create", {}).catch(() => undefined);
    const call = await gw.waitForCall("threads.create");
    expect(call.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps error responses to PsycheError and rejects while unpaired", async () => {
    gw = await new MockGateway({ pair: { phase: "pending", code: "48-21" } }).start();
    const { statuses } = connect();
    await until(() => statuses.at(-1)?.phase === "pending");
    expect(statuses.at(-1)?.pairingCode).toBe("48-21");
    const err = await conn?.call("threads.list", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PsycheError);
    expect((err as PsycheError).code).toBe("unavailable");
    expect((err as PsycheError).retryable).toBe(true);
  });

  it("reconnects after the Gateway drops it and asks the shell to resync", async () => {
    gw = await new MockGateway({
      handlers: { "tasks.get": () => Promise.reject(new PsycheError("not_found", "no task")) },
    }).start();
    const { statuses, resyncs } = connect();
    await until(() => conn?.isPaired() === true);
    const err = await conn
      ?.call("tasks.get", { taskId: "01JBXY6Q8Z0000000000000000" })
      .catch((e) => e);
    expect((err as PsycheError).code).toBe("not_found");

    gw.dropClients();
    await until(() => statuses.some((s) => s.phase === "disconnected"));
    await until(() => conn?.isPaired() === true, 5_000);
    expect(resyncs()).toBe(1);
    expect(gw.connects.length).toBe(2);
  });

  it("stops reconnecting once denied", async () => {
    gw = await new MockGateway({ pair: { phase: "denied", reason: "revoked" } }).start();
    const { statuses } = connect();
    await until(() => statuses.at(-1)?.phase === "denied");
    await new Promise((r) => setTimeout(r, 700));
    expect(gw.connects.length).toBe(1);
  });
});

describe("GatewayConnection failure paths", () => {
  it("drops the socket when signing fails and backs off when params fail", async () => {
    gw = await new MockGateway().start();
    const { statuses } = connect({
      sign: () => Promise.reject(new Error("keychain locked")),
    });
    await until(() => statuses.some((s) => s.phase === "error"));
    await until(() => statuses.some((s) => s.phase === "disconnected"));
    conn?.stop();

    let calls = 0;
    const second = connect({
      connectParams: () => {
        calls++;
        throw new Error("no key");
      },
    });
    await until(() => calls >= 2, 3_000);
    expect(second.statuses.at(-1)?.attempt).toBeGreaterThanOrEqual(1);
    expect(conn?.isPaired()).toBe(false);
  });
});
