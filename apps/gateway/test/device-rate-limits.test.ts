import { afterEach, describe, expect, it } from "vitest";
import { FakeNode } from "./fake-node.ts";
import {
  desktopClient,
  ik,
  newDeviceKey,
  remoteClient,
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
    const a = await remoteClient(t.gateway, key, "desk");
    const b = await remoteClient(t.gateway, key, "desk");
    clients.push(a, b);
    expect((await a.request("threads.list", {})).ok).toBe(true);
    expect((await b.request("threads.list", {})).ok).toBe(true);
    expect((await a.request("threads.list", {})).ok).toBe(true);
    expect(await b.request("threads.list", {})).toMatchObject({
      ok: false,
      error: { code: "rate_limited", retryable: true, details: { scope: "requests" } },
    });
    // Another device has its own budget.
    const other = await remoteClient(t.gateway, newDeviceKey(), "other");
    clients.push(other);
    expect((await other.request("threads.list", {})).ok).toBe(true);
    clock += 61_000;
    expect((await a.request("threads.list", {})).ok).toBe(true);
  });

  it("has a tighter budget for side-effecting methods", async () => {
    await setup({ deviceSideEffectsPerMinute: 2 });
    const c = await remoteClient(t.gateway, newDeviceKey(), "desk");
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
    const desk = await remoteClient(t.gateway, newDeviceKey(), "desk");
    clients.push(desk);
    const node = await FakeNode.connectRemote(t.gateway, {
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

  it("tells a limited device how long to wait", async () => {
    await setup({ deviceRequestsPerMinute: 2 });
    const c = await remoteClient(t.gateway, newDeviceKey(), "desk");
    clients.push(c);
    await c.request("threads.list", {});
    await c.request("threads.list", {});
    clock += 20_000;
    expect(await c.request("threads.list", {})).toMatchObject({
      ok: false,
      error: { code: "rate_limited", details: { scope: "requests", retryAfterSec: 40 } },
    });
  });

  it("gives the desktop shell on this computer ten times the budget, so normal use never trips", async () => {
    await setup({ deviceRequestsPerMinute: 2, deviceSideEffectsPerMinute: 2 });
    const desk = await desktopClient(t.gateway, newDeviceKey(), "shell");
    clients.push(desk);
    // Ten times the plain budget of two: twenty reads...
    for (let i = 0; i < 20; i++) expect((await desk.request("threads.list", {})).ok).toBe(true);
    // ...and a runaway loop in the shell still ends at the ceiling.
    expect(await desk.request("threads.list", {})).toMatchObject({
      ok: false,
      error: { code: "rate_limited", details: { scope: "requests" } },
    });
  });

  it("gives the shell ten times the side-effect budget too", async () => {
    await setup({ deviceRequestsPerMinute: 100, deviceSideEffectsPerMinute: 2 });
    const desk = await desktopClient(t.gateway, newDeviceKey(), "shell");
    clients.push(desk);
    for (let i = 0; i < 20; i++) {
      expect((await desk.request("threads.create", { kind: "side" }, ik())).ok).toBe(true);
    }
    expect(await desk.request("threads.create", { kind: "side" }, ik())).toMatchObject({
      ok: false,
      error: { code: "rate_limited", details: { scope: "side_effects" } },
    });
  });

  it("names the request budget when that is the one that filled", async () => {
    await setup({ deviceRequestsPerMinute: 1, deviceSideEffectsPerMinute: 50 });
    const c = await remoteClient(t.gateway, newDeviceKey(), "desk");
    clients.push(c);
    await c.request("threads.list", {});
    expect(await c.request("threads.create", { kind: "side" }, ik())).toMatchObject({
      ok: false,
      error: { code: "rate_limited", details: { scope: "requests" } },
    });
  });
});
