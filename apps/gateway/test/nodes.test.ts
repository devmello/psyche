import type { NodeInfo } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RecordingBroker } from "./agent.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import {
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

let t: TestGateway;
let broker: RecordingBroker;
let node: FakeNode | null = null;
let desk: TestClient | null = null;

const HANDLERS: FakeNodeHandler[] = [
  {
    capability: { name: "system.echo", sideEffect: "none", streaming: true },
    run: (params, emit) => {
      emit({ progress: 1 });
      return params;
    },
  },
  {
    capability: { name: "reminders.create", sideEffect: "write", targetKind: "app" },
    run: () => ({ shown: true }),
    receipt: { outcome: "ok", summary: "Showed a notification" },
  },
  { capability: { name: "vault.unlock", sideEffect: "write" }, run: () => "should never run" },
  {
    capability: { name: "apps.applescript", sideEffect: "destructive", targetKind: "app" },
    run: () => "should never run",
  },
  { capability: { name: "slow.op", sideEffect: "none" }, hang: true },
  {
    capability: { name: "notify.authorization_status", sideEffect: "read" },
    run: () => ({ authorization: "notDetermined" }),
  },
  { capability: { name: "notify.show", sideEffect: "write" }, run: () => "should never run" },
];

async function setup(policy: ConstructorParameters<typeof RecordingBroker>[0] = {}) {
  broker = new RecordingBroker({ armDelayMs: 0, ...policy });
  t = await startTestGateway({ broker });
  desk = await desktopClient(t.gateway);
  node = await FakeNode.connect(t.gateway.config.nodeSocketPath, {
    origin: t.gateway.origin,
    secret: t.gateway.handshakeSecret,
    handlers: HANDLERS,
  });
  return { desk, node };
}

afterEach(async () => {
  desk?.close();
  await node?.close().catch(() => {});
  node = null;
  await t?.cleanup();
});

describe("node registry", () => {
  it("registers a paired node with its capabilities and lists it", async () => {
    const { desk, node } = await setup();
    expect(node.nodeId).toBeTruthy();
    const { nodes } = await desk.call<{ nodes: NodeInfo[] }>("nodes.list", {});
    expect(nodes).toEqual([
      expect.objectContaining({ id: node.nodeId, kind: "mac-helper", status: "online" }),
    ]);
    const caps = await desk.call<{ capabilities: { name: string }[] }>("nodes.capabilities", {
      nodeId: node.nodeId,
    });
    expect(caps.capabilities.map((c) => c.name)).toEqual(HANDLERS.map((h) => h.capability.name));
  });

  it("invokes an allowed capability and returns the final result", async () => {
    const { desk, node } = await setup();
    const res = await desk.call<{ ok: boolean; result: unknown; receipt?: unknown }>(
      "nodes.invoke",
      { nodeId: node.nodeId, capability: "system.echo", params: { hello: "world" } },
      ik(),
    );
    expect(res).toMatchObject({ ok: true, result: { hello: "world" } });
    expect(res.receipt).toBeUndefined();
    expect(node.invocations).toEqual([{ capability: "system.echo", params: { hello: "world" } }]);
  });

  it("asks for approval, then runs with the approvalId passed through and records a receipt", async () => {
    const { desk, node } = await setup({ policy: { byTool: { "node.reminders.create": "ask" } } });
    const args = { nodeId: node.nodeId, capability: "reminders.create", params: { title: "Hi" } };
    const first = await desk.request("nodes.invoke", args, ik());
    expect(first).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const approvalId = (first.error as { details: { approvalId: string } }).details.approvalId;
    const card = await desk.waitForEvent((e) => e.event === "approval.created");
    // The card shows the full arguments (#274).
    expect(card.payload).toMatchObject({
      approval: { details: { capability: "reminders.create", params: { title: "Hi" } } },
    });
    expect(node.invocations).toHaveLength(0);

    const issued = broker.issued[0];
    const token = Object.values(issued?.answerTokens ?? {})[0] as string;
    await broker.answer({
      approvalId,
      answerToken: token,
      decision: "approve",
      decidedBy: { deviceId: "owner" },
    });
    const res = await desk.call<{ ok: boolean; receipt: { kind: string; approvalId: string } }>(
      "nodes.invoke",
      { ...args, approvalId },
      ik(),
    );
    expect(res.ok).toBe(true);
    expect(res.receipt).toMatchObject({ kind: "node.reminders.create", approvalId });
    expect(node.invocations).toEqual([
      { capability: "reminders.create", params: { title: "Hi" }, approvalId },
    ]);
    await desk.waitForEvent((e) => e.event === "receipt.created");

    // The approval was single-use and bound to these exact arguments.
    const replay = await desk.request("nodes.invoke", { ...args, approvalId }, ik());
    expect(replay).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const changed = await desk.request(
      "nodes.invoke",
      { ...args, params: { title: "Other" }, approvalId },
      ik(),
    );
    expect(changed.ok).toBe(false);
  });

  it("denies by policy without reaching the node", async () => {
    const { desk, node } = await setup({ policy: { byTool: { "node.reminders.create": "deny" } } });
    const res = await desk.request(
      "nodes.invoke",
      { nodeId: node.nodeId, capability: "reminders.create", params: {} },
      ik(),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "policy_denied" } });
    expect(node.invocations).toHaveLength(0);
  });

  it("never reaches a capability that has an agent tool, such as apps.applescript (#274)", async () => {
    const { desk, node } = await setup({ policy: { default: "allow" } });
    const res = await desk.request(
      "nodes.invoke",
      {
        nodeId: node.nodeId,
        capability: "apps.applescript",
        params: { source: 'tell application "Mail" to send', target: "com.apple.mail" },
      },
      ik(),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(node.invocations).toHaveLength(0);
  });

  it("lets the desktop read the helper's notification permission, never post one (#540)", async () => {
    const { desk, node } = await setup({ policy: { default: "allow" } });
    // Onboarding polls this every few seconds; it was refused as notify.* (#274).
    const status = await desk.call<{ ok: boolean; result: unknown }>(
      "nodes.invoke",
      { nodeId: node.nodeId, capability: "notify.authorization_status", params: {} },
      ik(),
    );
    expect(status).toMatchObject({ ok: true, result: { authorization: "notDetermined" } });
    const show = await desk.request(
      "nodes.invoke",
      { nodeId: node.nodeId, capability: "notify.show", params: { title: "Approve?" } },
      ik(),
    );
    expect(show).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(node.invocations.map((i) => i.capability)).toEqual(["notify.authorization_status"]);
  });

  it("never reaches helper-internal capabilities such as vault.unlock", async () => {
    const { desk, node } = await setup({ policy: { default: "allow" } });
    const res = await desk.request(
      "nodes.invoke",
      { nodeId: node.nodeId, capability: "vault.unlock", params: {} },
      ik(),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(node.invocations).toHaveLength(0);
    expect(broker.decisions).toHaveLength(0);
  });

  it("answers unknown capabilities and offline nodes, and marks a disconnected node offline", async () => {
    const { desk, node } = await setup();
    expect(
      (
        await desk.request(
          "nodes.invoke",
          { nodeId: node.nodeId, capability: "nope", params: {} },
          ik(),
        )
      ).error,
    ).toMatchObject({ code: "not_found" });
    const pending = desk.request(
      "nodes.invoke",
      { nodeId: node.nodeId, capability: "slow.op", params: {} },
      ik(),
    );
    await new Promise((r) => setTimeout(r, 50));
    await node.close();
    expect(await pending).toMatchObject({
      ok: true,
      payload: { ok: false, error: { code: "unavailable" } },
    });
    await desk.waitForEvent(
      (e) =>
        e.event === "node.updated" && (e.payload as { node: NodeInfo }).node.status === "offline",
    );
    expect(
      (
        await desk.request(
          "nodes.invoke",
          { nodeId: node.nodeId, capability: "system.echo", params: {} },
          ik(),
        )
      ).error,
    ).toMatchObject({ code: "unavailable" });
  });
});
