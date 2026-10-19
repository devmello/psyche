import { afterEach, describe, expect, it } from "vitest";
import { NodeAgent, type NodeAgentOptions } from "../src/agent.ts";
import { Backoff } from "../src/backoff.ts";
import type { CapabilityEntry, CapabilityProvider } from "../src/capabilities/types.ts";
import { generateIdentity } from "../src/identity.ts";
import { FakeGateway } from "./fake-gateway.ts";

const agents: NodeAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.stop()));
});

function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function staticProvider(
  id: string,
  entries: CapabilityEntry[],
): CapabilityProvider & {
  set(next: CapabilityEntry[]): void;
} {
  let current = entries;
  const listeners: (() => void)[] = [];
  return {
    id,
    async entries() {
      return current;
    },
    onChange: (l) => listeners.push(l),
    set(next) {
      current = next;
      for (const l of listeners) l();
    },
  };
}

const echo: CapabilityEntry = {
  manifest: { name: "test.echo", sideEffect: "none", streaming: true },
  async handler(params, ctx) {
    ctx.emit({ step: 1 });
    ctx.emit({ step: 2 });
    return { ok: true, result: { params, approvalId: ctx.approvalId ?? null } };
  },
};

const writer: CapabilityEntry = {
  manifest: { name: "test.write", sideEffect: "write", targetKind: "path" },
  async handler(_params, ctx) {
    return {
      ok: true,
      result: { written: true },
      receipt: ctx.receipt({ kind: "test.write", outcome: "ok", summary: "wrote one file" }),
    };
  },
};

function makeAgent(gw: FakeGateway, extra: Partial<NodeAgentOptions> = {}): NodeAgent {
  const agent = new NodeAgent({
    identity: generateIdentity(),
    name: "test node",
    platform: "linux",
    deviceFamily: "psyche-node",
    version: "0.0.0-test",
    providers: [staticProvider("test", [echo, writer])],
    connect: gw.connect,
    backoff: new Backoff({ initialMs: 5, maxMs: 20, random: () => 0.5 }),
    pendingRetryMs: 5,
    ...extra,
  });
  agents.push(agent);
  void agent.start();
  return agent;
}

describe("pairing", () => {
  it("signs the challenge and pairs as role node with its manifest", async () => {
    const gw = new FakeGateway();
    const paired = gw.nextPaired();
    const agent = makeAgent(gw);
    await paired;
    await until(() => agent.state === "paired");
    const sent = gw.connects[0];
    expect(sent?.role).toBe("node");
    expect(sent?.deviceFamily).toBe("psyche-node");
    expect(sent?.handshakeSecret).toBeUndefined();
    expect(sent?.capabilities?.map((c) => c.name)).toEqual(["test.echo", "test.write"]);
    expect(agent.nodeId).toBe("node_1");
  });

  it("waits while pending and pairs after the owner approves (Gateway closes, node reconnects)", async () => {
    const gw = new FakeGateway();
    let approved = false;
    gw.decide = () => (approved ? { phase: "paired" } : { phase: "pending", code: "WXYZ-2345" });
    const agent = makeAgent(gw);
    await until(() => agent.state === "pending");
    expect(agent.pairingCode).toBe("WXYZ-2345");
    approved = true;
    const paired = gw.nextPaired();
    gw.connections.at(-1)?.close("pairing approved");
    await paired;
    await until(() => agent.state === "paired");
    expect(agent.pairingCode).toBeNull();
    expect(gw.connects).toHaveLength(2);
  });

  it("stops for good when the device is revoked", async () => {
    const gw = new FakeGateway();
    gw.decide = () => ({ phase: "denied", reason: "device revoked" });
    const agent = makeAgent(gw);
    await agent.start();
    expect(agent.state).toBe("denied");
    expect(gw.connects).toHaveLength(1);
  });

  it("corrects receipts for Gateway clock skew", async () => {
    const gw = new FakeGateway();
    const skewMs = 5 * 60_000;
    gw.serverTime = () => new Date(Date.now() + skewMs);
    const paired = gw.nextPaired();
    const agent = makeAgent(gw);
    await paired;
    await until(() => agent.state === "paired");
    expect(Math.abs(agent.clock.offsetMs - skewMs)).toBeLessThan(1_000);
    const { result } = await gw.invoke("test.write", {});
    const r = await result;
    const created = Date.parse(r.receipt?.createdAt ?? "");
    expect(Math.abs(created - (Date.now() + skewMs))).toBeLessThan(1_000);
  });
});

describe("invoke", () => {
  async function pairedAgent(extra: Partial<NodeAgentOptions> = {}) {
    const gw = new FakeGateway();
    const paired = gw.nextPaired();
    const agent = makeAgent(gw, extra);
    await paired;
    await until(() => agent.state === "paired");
    return { gw, agent };
  }

  it("accepts, streams node.event in order, then sends exactly one node.result", async () => {
    const { gw } = await pairedAgent();
    const { accepted, result, invocationId } = await gw.invoke("test.echo", { x: 1 });
    expect(accepted).toMatchObject({ ok: true, payload: { accepted: true } });
    const r = await result;
    expect(r).toMatchObject({ ok: true, result: { params: { x: 1 }, approvalId: null } });
    await until(() => (gw.events.get(invocationId)?.length ?? 0) === 2);
    expect(gw.events.get(invocationId)).toEqual([{ step: 1 }, { step: 2 }]);
  });

  it("passes the approval id through to the handler and into the receipt", async () => {
    const { gw } = await pairedAgent();
    const echoed = await (await gw.invoke("test.echo", {}, "appr_42")).result;
    expect(echoed.result).toMatchObject({ approvalId: "appr_42" });
    const written = await (await gw.invoke("test.write", {}, "appr_43")).result;
    expect(written.receipt).toMatchObject({
      kind: "test.write",
      approvalId: "appr_43",
      outcome: "ok",
      externalRefs: { invocationId: expect.any(String) },
    });
  });

  it("refuses unknown capabilities and duplicate invocation ids", async () => {
    const { gw } = await pairedAgent();
    const unknown = await gw.request("node.invoke", {
      invocationId: "x1",
      capability: "nope",
      params: {},
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: "not_found" } });
    const bad = await gw.request("node.invoke", { capability: "test.echo" });
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("turns a throwing handler into an error result", async () => {
    const boom: CapabilityEntry = {
      manifest: { name: "test.boom", sideEffect: "none" },
      async handler() {
        throw new Error("kaput");
      },
    };
    const { gw } = await pairedAgent({ providers: [staticProvider("t", [boom])] });
    const r = await (await gw.invoke("test.boom", {})).result;
    expect(r).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("aborts in-flight work on node.cancel", async () => {
    let sawAbort = false;
    const slow: CapabilityEntry = {
      manifest: { name: "test.slow", sideEffect: "none" },
      handler: (_p, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve({ ok: false, error: { code: "cancelled", message: "cancelled" } });
          });
        }),
    };
    const { gw } = await pairedAgent({ providers: [staticProvider("t", [slow])] });
    const { result, invocationId } = await gw.invoke("test.slow", {});
    await gw.request("node.cancel", { invocationId });
    expect(await result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(sawAbort).toBe(true);
  });
});

describe("reconnection", () => {
  it("reconnects with backoff after the Gateway drops and while it is down", async () => {
    const gw = new FakeGateway();
    const first = gw.nextPaired();
    const agent = makeAgent(gw);
    await first;
    gw.down = true;
    gw.drop();
    await until(() => agent.state === "connecting");
    await new Promise((r) => setTimeout(r, 40));
    gw.down = false;
    const second = gw.nextPaired();
    await second;
    await until(() => agent.state === "paired");
    expect(gw.connects.length).toBe(2);
    const r = await (await gw.invoke("test.echo", { again: true })).result;
    expect(r.ok).toBe(true);
  });

  it("aborts invocations when the connection drops", async () => {
    let aborted = false;
    const hang: CapabilityEntry = {
      manifest: { name: "test.hang", sideEffect: "none" },
      handler: (_p, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ ok: false, error: { code: "cancelled", message: "x" } });
          });
        }),
    };
    const gw = new FakeGateway();
    const paired = gw.nextPaired();
    const agent = makeAgent(gw, { providers: [staticProvider("t", [hang])] });
    await paired;
    await until(() => agent.state === "paired");
    await gw.invoke("test.hang", {});
    gw.drop();
    await until(() => aborted);
    expect(agent.inFlight).toBe(0);
  });

  it("re-declares capabilities by reconnecting when a provider changes", async () => {
    const gw = new FakeGateway();
    const provider = staticProvider("t", [echo]);
    const first = gw.nextPaired();
    const agent = makeAgent(gw, { providers: [provider] });
    await first;
    const second = gw.nextPaired();
    provider.set([echo, writer]);
    await second;
    await until(() => agent.state === "paired");
    expect(gw.connects.at(-1)?.capabilities?.map((c) => c.name)).toEqual([
      "test.echo",
      "test.write",
    ]);
  });
});
