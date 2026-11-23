import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCursorStore } from "@psyche/channels";
import { updateDevice } from "@psyche/db";
import type { PresenceVerifier } from "@psyche/permissions";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeMessagesNode, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { composeChannels } from "../src/compose/channels.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * Removing the last `groupAllowFrom` entry widens group triggering to everyone allowed in direct
 * messages, so it needs the owner's card. A removal that leaves entries, or a channel with nobody
 * allowed in direct messages, stays a plain admin call.
 */

const ACCOUNT = "psyche@icloud.com";
const OWNER = "+15550001111";
const PARTNER = "+15550002222";
const OTHER = "+15550003333";
const DEVICE = "admin-group-gate";

const touchId: PresenceVerifier = {
  verify: async (assertion, challenge) => assertion.signature === `signed:${challenge}`,
};

const clients: TestClient[] = [];
let composed: ComposedGateway | null = null;
let home = "";

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed?.gateway.context.db.close();
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

async function boot(): Promise<TestClient> {
  home = mkdtempSync(join(tmpdir(), "psyche-group-gate-"));
  const node = new FakeMessagesNode();
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    presence: touchId,
    parts: [
      (s) =>
        composeChannels(s, {
          imessage: { account: ACCOUNT, node: () => node, cursor: new MemoryCursorStore() },
          healthIntervalMs: 0,
        }),
    ],
  });
  const key = newDeviceKey();
  (await desktopClient(composed.gateway, key, DEVICE)).close();
  updateDevice(composed.gateway.context.db, DEVICE, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  const admin = await desktopClient(composed.gateway, key, DEVICE);
  clients.push(admin);
  return admin;
}

/** Answers a card with a plain tap (no presence assertion: payments only need one). */
async function approveWithTap(admin: TestClient, res: Record<string, unknown>) {
  expect(res).toMatchObject({ ok: false, error: { code: "approval_required" } });
  const approvalId = (res as { error: { details: { approvalId: string } } }).error.details
    .approvalId;
  const got = await admin.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId },
  );
  expect(got.approval).toMatchObject({ kind: "policy_change", requiresAuthentication: false });
  await new Promise((r) => setTimeout(r, 450)); // past the arm delay
  expect(
    await admin.request(
      "approvals.answer",
      { approvalId, answerToken: got.answerToken ?? "", decision: "approve" },
      ik(),
    ),
  ).toMatchObject({ ok: true });
  return { approvalId, approval: got.approval };
}

/** Creates the channel; creating one is itself a presence-gated admin change. */
async function createChannel(admin: TestClient, params: Record<string, unknown>): Promise<string> {
  const first = await admin.request("channels.configure", params, ik());
  const { approvalId } = await approveWithTap(admin, first);
  const made = await admin.request("channels.configure", { ...params, approvalId }, ik());
  expect(made).toMatchObject({ ok: true });
  return (made.payload as { channel: { id: string } }).channel.id;
}

describe("removing the last group sender needs the owner's card", () => {
  it("asks for a card when the removal leaves groupAllowFrom empty, then removes once approved", async () => {
    const admin = await boot();
    const channelId = await createChannel(admin, {
      type: "imessage",
      account: ACCOUNT,
      dmPolicy: "allowlist",
      allowFrom: [OWNER],
      groupAllowFrom: [PARTNER],
      ownerIds: [OWNER],
    });
    const remove = { channelId, list: "groupAllowFrom", remove: [PARTNER] };

    const first = await admin.request("channels.allowlist.update", remove, ik());
    const { approvalId, approval } = await approveWithTap(admin, first);
    expect(approval.details).toMatchObject({ method: "channels.allowlist.update" });
    // Nothing changed while the card waits.
    const before = await admin.call<{ channel: { groupAllowFrom: string[] } }>("channels.list", {});
    expect(JSON.stringify(before)).toContain(PARTNER);

    const done = await admin.request("channels.allowlist.update", { ...remove, approvalId }, ik());
    expect(done).toMatchObject({ ok: true });
    expect(
      (done.payload as { channel: { groupAllowFrom: string[] } }).channel.groupAllowFrom,
    ).toEqual([]);
  });

  it("a removal that leaves group senders is still a plain admin call", async () => {
    const admin = await boot();
    const channelId = await createChannel(admin, {
      type: "imessage",
      account: ACCOUNT,
      dmPolicy: "allowlist",
      allowFrom: [OWNER],
      groupAllowFrom: [PARTNER, OTHER],
      ownerIds: [OWNER],
    });
    const done = await admin.request(
      "channels.allowlist.update",
      { channelId, list: "groupAllowFrom", remove: [PARTNER] },
      ik(),
    );
    expect(done).toMatchObject({ ok: true });
    expect(
      (done.payload as { channel: { groupAllowFrom: string[] } }).channel.groupAllowFrom,
    ).toEqual([OTHER]);
  });

  it("emptying groupAllowFrom with nobody allowed in direct messages narrows, so no card", async () => {
    const admin = await boot();
    const channelId = await createChannel(admin, {
      type: "imessage",
      account: ACCOUNT,
      dmPolicy: "pairing",
      allowFrom: [],
      groupAllowFrom: [PARTNER],
      ownerIds: [],
    });
    expect(
      await admin.request(
        "channels.allowlist.update",
        { channelId, list: "groupAllowFrom", remove: [PARTNER] },
        ik(),
      ),
    ).toMatchObject({ ok: true });
  });
});
