import { afterEach, describe, expect, it } from "vitest";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import {
  desktopClient,
  ik,
  remoteClient,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

let t: TestGateway;
let node: FakeNode | null = null;
let desk: TestClient | null = null;

const HANDLERS: FakeNodeHandler[] = [
  {
    capability: { name: "notify.authorization_status", sideEffect: "read" },
    run: () => ({ status: "notDetermined" }),
  },
  {
    capability: { name: "notify.request_authorization", sideEffect: "write" },
    run: () => ({ status: "authorized", granted: true }),
  },
  { capability: { name: "permissions.status", sideEffect: "read" }, run: () => ({}) },
];

afterEach(async () => {
  desk?.close();
  await node?.close().catch(() => {});
  node = null;
  await t?.cleanup();
});

/**
 * The desktop's first launch (`askHelperNotificationsIfUndetermined`) reads the helper's
 * notification status, then asks for it. Before 95b91c89a the ask (`notify.request_authorization`,
 * a `write`) went through the broker and queued an approval card nobody asked for, and the helper
 * then could not show that card's notification (`permission_not_determined` -> "forbidden").
 */
describe("launch-time helper calls, real broker and default policy", () => {
  async function connect() {
    t = await startTestGateway();
    desk = await desktopClient(t.gateway);
    node = await FakeNode.connect(t.gateway.config.nodeSocketPath, {
      origin: t.gateway.origin,
      secret: t.gateway.handshakeSecret,
      handlers: HANDLERS,
    });
    return { desk, node };
  }
  const pendingApprovals = async (c: TestClient) => {
    const res = await c.request("approvals.list", {});
    const payload = (res as { payload?: { approvals?: { status: string }[] } }).payload;
    return (payload?.approvals ?? []).filter((a) => a.status === "pending");
  };

  it("status reads and the owner's own notification ask create no approval", async () => {
    const { desk, node } = await connect();
    for (const [capability, params] of [
      ["notify.authorization_status", {}],
      ["permissions.status", {}],
      ["notify.request_authorization", { provisional: false }],
    ] as const) {
      const res = await desk.request(
        "nodes.invoke",
        { nodeId: node.nodeId, capability, params },
        ik(),
      );
      expect(res, capability).toMatchObject({ ok: true });
    }
    expect(node.invocations.map((i) => i.capability)).toEqual([
      "notify.authorization_status",
      "permissions.status",
      "notify.request_authorization",
    ]);
    expect(await pendingApprovals(desk)).toEqual([]);
  });

  it("a state change that is not the owner's own prompt keeps its policy", async () => {
    const { desk, node } = await connect();
    const res = await desk.request(
      "nodes.invoke",
      {
        nodeId: node.nodeId,
        capability: "notify.request_authorization",
        params: { provisional: true },
      },
      ik(),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "policy_denied" } });
    expect(node.invocations).toHaveLength(0);
  });

  it("a paired remote device asking for the prompt is not waved through", async () => {
    const { node } = await connect();
    const phone = await remoteClient(t.gateway);
    try {
      const res = await phone.request(
        "nodes.invoke",
        {
          nodeId: node.nodeId,
          capability: "notify.request_authorization",
          params: { provisional: false },
        },
        ik(),
      );
      expect(res).toMatchObject({ ok: false });
      expect(node.invocations).toHaveLength(0);
    } finally {
      phone.close();
    }
  });
});
