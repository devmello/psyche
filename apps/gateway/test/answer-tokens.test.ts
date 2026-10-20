import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode } from "./fake-node.ts";
import { desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

let home = "";
let composed: ComposedGateway | null = null;
let node: FakeNode | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await node?.close();
  node = null;
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("approval.created carries the approver's own answer token (issue #50)", () => {
  it("sends the token to an approver, not to a read-only device, and the token answers the card", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-tokens-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const gw = composed.gateway;
    node = await FakeNode.connect(gw.config.nodeSocketPath, {
      origin: gw.origin,
      secret: gw.handshakeSecret,
      handlers: [
        {
          capability: { name: "files.trash", sideEffect: "destructive" },
          run: () => ({ ok: true }),
        },
      ],
    });
    const approver = await desktopClient(gw, newDeviceKey(), "desk-approver");
    const viewerKey = newDeviceKey();
    const first = await desktopClient(gw, viewerKey, "desk-viewer");
    first.close();
    updateDevice(gw.context.db, "desk-viewer", { scopes: ["operator.read", "operator.write"] });
    const viewer = await desktopClient(gw, viewerKey, "desk-viewer");
    clients.push(approver, viewer);

    const res = await viewer.request(
      "nodes.invoke",
      { nodeId: node.nodeId, capability: "files.trash", params: { path: "/tmp/x" } },
      ik(),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const approvalId = (res.error as { details: { approvalId: string } }).details.approvalId;

    const mine = await approver.waitForEvent(
      (e) =>
        e.event === "approval.created" &&
        (e.payload as { approval: { id: string } }).approval.id === approvalId,
    );
    const token = (mine.payload as { answerToken?: string }).answerToken;
    expect(token).toBeTruthy();
    const theirs = await viewer.waitForEvent(
      (e) =>
        e.event === "approval.created" &&
        (e.payload as { approval: { id: string } }).approval.id === approvalId,
    );
    expect((theirs.payload as { answerToken?: string }).answerToken).toBeUndefined();

    await new Promise((r) => setTimeout(r, 450)); // cards arm after 400 ms
    const answered = await approver.request(
      "approvals.answer",
      { approvalId, answerToken: token, decision: "approve", scope: "once" },
      ik(),
    );
    expect(answered).toMatchObject({ ok: true });
  });
});
