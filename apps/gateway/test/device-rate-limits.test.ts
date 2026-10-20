import { afterEach, describe, expect, it } from "vitest";
import { FakeNode } from "./fake-node.ts";
import {
  desktopClient,
  ik,
  newDeviceKey,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

let t: TestGateway;
const clients: TestClient[] = [];
let clock = Date.parse("2026-10-20T12:00:00.000Z");

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.cleanup();
});

async function setup(limits: {
  deviceRequestsPerMinute?: number;
  deviceSideEffectsPerMinute?: number;
}) {
  clock = Date.parse("2026-10-20T12:00:00.000Z");
  t = await startTestGateway({ now: () => new Date(clock), limits });
}

describe("per-device rate limits (security §10)", () => {
  it("limits requests per device across its connections and recovers after the window", async () => {
    await setup({ deviceRequestsPerMinute: 3 });
    const key = newDeviceKey();
    const a = await desktopClient(t.gateway, key, "desk");
    const b = await desktopClient(t.gateway, key, "desk");
    clients.push(a, b);
    expect((await a.request("threads.list", {})).ok).toBe(true);
    expect((await b.request("threads.list", {})).ok).toBe(true);
    expect((await a.request("threads.list", {})).ok).toBe(true);
    expect(await b.request("threads.list", {})).toMatchObject({
      ok: false,
      error: { code: "rate_limited", retryable: true, details: { scope: "requests" } },
    });
    // Another device has its own budget.
    const other = await desktopClient(t.gateway, newDeviceKey(), "other");
    clients.push(other);
    expect((await other.request("threads.list", {})).ok).toBe(true);
    clock += 61_000;
    expect((await a.request("threads.list", {})).ok).toBe(true);
  });

  it("has a tighter budget for side-effecting methods", async () => {
    await setup({ deviceSideEffectsPerMinute: 2 });
    const c = await desktopClient(t.gateway, newDeviceKey(), "desk");
    clients.push(c);
    expect((await c.request("threads.create", { kind: "side" }, ik())).ok).toBe(true);
    expect((await c.request("threads.create", { kind: "side" }, ik())).ok).toBe(true);
    expect(await c.request("threads.create", { kind: "side" }, ik())).toMatchObject({
      ok: false,
      error: { code: "rate_limited", details: { scope: "side_effects" } },
    });
    expect((await c.request("threads.list", {})).ok).toBe(true);
  });

  it("does not count node-protocol frames", async () => {
    await setup({ deviceRequestsPerMinute: 1 });
    const desk = await desktopClient(t.gateway, newDeviceKey(), "desk");
    clients.push(desk);
    const node = await FakeNode.connect(t.gateway.config.nodeSocketPath, {
      origin: t.gateway.origin,
      secret: t.gateway.handshakeSecret,
      handlers: [
        {
          capability: { name: "system.echo", sideEffect: "none", streaming: true },
          run: (params, emit) => {
            for (let i = 0; i < 5; i++) emit({ i });
            return params;
          },
        },
      ],
    });
    const res = await desk.request(
      "nodes.invoke",
      { nodeId: node.nodeId, capability: "system.echo", params: { x: 1 } },
      ik(),
    );
    expect(res).toMatchObject({ ok: true, payload: { ok: true, result: { x: 1 } } });
    await node.close();
  });
});
