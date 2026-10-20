import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCursorStore } from "@psyche/channels";
import type { ModelEvent } from "@psyche/protocol";
import { FakeMessagesNode, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ComposedChannels,
  channelsSetupFromEnv,
  composeChannels,
} from "../src/compose/channels.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** N5 in the Gateway: iMessage replies under the broker's channel reply authority. */

const ACCOUNT = "psyche@icloud.com";
const OWNER = "+15550001111";
const STRANGER = "+15550003333";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup(model: FakeModelProvider) {
  home = mkdtempSync(join(tmpdir(), "psyche-imessage-"));
  const node = new FakeMessagesNode();
  let channels: ComposedChannels | undefined;
  let services: ComposeServices | undefined;
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: model, model: "fake/model" },
    parts: [
      (s) => {
        services = s;
        channels = composeChannels(s, {
          imessage: { account: ACCOUNT, node: () => node, cursor: new MemoryCursorStore() },
          healthIntervalMs: 0,
        });
        return channels;
      },
    ],
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  await owner.call(
    "channels.configure",
    {
      type: "imessage",
      account: ACCOUNT,
      dmPolicy: "allowlist",
      allowFrom: [OWNER],
      ownerIds: [OWNER],
    },
    ik(),
  );
  const ch = channels as ComposedChannels;
  await vi.waitFor(() =>
    expect(node.invocations.some((i) => i.capability === "messages.watch")).toBe(true),
  );
  return { node, channels: ch, services: services as ComposeServices };
}

describe("iMessage channel reply authority (N5)", () => {
  it("answers the owner's message with a decided, audited, binding-verified approval", async () => {
    const { node, services } = await setup(FakeModelProvider.script([say("Hello from Psyche.")]));
    node.receive({ from: OWNER, text: "hi there" });

    await vi.waitFor(() => expect(node.sends).toHaveLength(1), { timeout: 5000 });
    const send = node.sends[0];
    expect(send).toMatchObject({ chatId: `iMessage;-;${OWNER}`, text: "Hello from Psyche." });
    const approvalId = send?.approvalId ?? "";
    const approval = await services.broker.get(approvalId);
    expect(approval).toMatchObject({
      kind: "message_send",
      status: "approved",
      scopeGranted: "once",
      decidedBy: { channel: "imessage", senderId: OWNER },
      target: { kind: "recipient", value: `iMessage;-;${OWNER}` },
    });
    expect(approval?.requestedBy.runId).not.toBeNull();
    // Consumed by the dispatch check: it cannot authorize a second send.
    expect(
      await services.broker.verifyBinding(approvalId, approval?.bindingHash ?? ""),
    ).toMatchObject({ ok: false, reason: "consumed" });
    const decided = await services.audit.list({ kind: "approval.decided" });
    expect(decided.at(-1)?.data).toMatchObject({ rule: "channel_reply:turn", purpose: "reply" });
    const receipts = await services.broker.listReceipts();
    expect(
      receipts.some((r) => r.kind === "node.messages.send" && r.approvalId === approvalId),
    ).toBe(true);
  });

  it("refuses a send to a conversation no authorized sender wrote in; nothing reaches the Mac", async () => {
    const { node, channels } = await setup(new FakeModelProvider());
    const channel = channels.service.listChannels().find((c) => c.type === "imessage");
    await expect(
      channels.service.send({ channelId: channel?.id ?? "", chatId: STRANGER }, "Hi, it's Psyche."),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(node.sends).toHaveLength(0);
  });

  it("is off unless PSYCHE_IMESSAGE_ACCOUNT names the Mac's account", () => {
    const read = () => "";
    expect(channelsSetupFromEnv({}, read).imessage).toBeUndefined();
    expect(
      channelsSetupFromEnv(
        { PSYCHE_IMESSAGE_ACCOUNT: ACCOUNT, PSYCHE_IMESSAGE_NODE_ID: "node_mac" },
        read,
      ).imessage,
    ).toEqual({ account: ACCOUNT, nodeId: "node_mac" });
  });
});
