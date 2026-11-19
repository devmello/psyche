import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCursorStore } from "@psyche/channels";
import { createThread, listMessagesPage, setSetting } from "@psyche/db";
import { bindingFor, fillOutboundText, OUTBOUND_TEXT, outboundText } from "@psyche/permissions";
import type { ModelEvent } from "@psyche/protocol";
import { FakeMessagesNode, FakeModelProvider, fixtureSecret } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ComposedChannels,
  channelReplyAuthority,
  composeChannels,
  noteHeldMessage,
  verifiedMessagesSends,
} from "../src/compose/channels.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** N5: iMessage replies carry their turn to the reply authority and are verified at dispatch. */

const ACCOUNT = "psyche@icloud.com";
const OWNER = "+15550001111";
const OWNER_CHAT = `iMessage;-;${OWNER}`;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];
// FakeMessagesNode stamps rows from 2026-10-19T12:00Z; the Gateway's clock runs from there.
const BASE = Date.parse("2026-10-19T12:00:00.000Z");
const started = Date.now();
const clock = { now: () => BASE + (Date.now() - started) };

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup(model: FakeModelProvider, extra: Record<string, unknown> = {}) {
  home = mkdtempSync(join(tmpdir(), "psyche-imessage-"));
  const node = new FakeMessagesNode();
  let channels: ComposedChannels | undefined;
  let services: ComposeServices | undefined;
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    clock,
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
      ...extra,
    },
    ik(),
  );
  await vi.waitFor(() =>
    expect(node.invocations.some((i) => i.capability === "messages.watch")).toBe(true),
  );
  return { node, services: services as ComposeServices };
}

const sha = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

describe("iMessage reply authority in the Gateway (N5)", () => {
  it("answers the owner under an approval tied to the run, spent at dispatch, with a receipt", async () => {
    const { node, services } = await setup(FakeModelProvider.script([say("Hello from Psyche.")]));
    node.receive({ from: OWNER, text: "hi there" });

    await vi.waitFor(() => expect(node.sends).toHaveLength(1), { timeout: 5000 });
    const send = node.sends[0];
    expect(send).toMatchObject({ chatId: OWNER_CHAT, text: "Hello from Psyche." });
    const approvalId = send?.approvalId ?? "";
    const approval = await services.rawBroker.get(approvalId);
    expect(approval).toMatchObject({
      kind: "message_send",
      status: "approved",
      scopeGranted: "once",
      decidedBy: { channel: "imessage", senderId: OWNER },
      taint: false,
    });
    expect(approval?.requestedBy.runId).not.toBeNull();
    expect(
      await services.rawBroker.verifyBinding(approvalId, approval?.bindingHash ?? ""),
    ).toMatchObject({ ok: false, reason: "consumed" });
    const receipts = await services.rawBroker.listReceipts();
    expect(
      receipts.some((r) => r.kind === "node.messages.send" && r.approvalId === approvalId),
    ).toBe(true);
  });

  it("the owner's own iMessage DM gets the redacted reply, and the audit entry holds kinds only (§3.9)", async () => {
    const card = fixtureSecret("link-virtual-card");
    const { node, services } = await setup(
      FakeModelProvider.script([say(`Your card is ${card}, code 482913.`)]),
    );
    // The notice follows the owner's language; pin it so the test does not depend on the Mac's.
    setSetting(services.db, "ui.language", "en");
    node.receive({ from: OWNER, text: "what card do I use?" });

    await vi.waitFor(() => expect(node.sends).toHaveLength(1), { timeout: 5000 });
    // The chat is `iMessage;-;<owner>`: the owner's, so the value is cut out and the rest is sent.
    expect(node.sends[0]).toMatchObject({
      chatId: OWNER_CHAT,
      text: "Your card is [withheld: open Psyche to see it], code 482913.",
    });
    const entry = (await services.audit.list()).find((e) => e.kind === "outbound.withheld");
    expect(entry?.data).toEqual({
      decision: "redact",
      channelType: "imessage",
      kinds: ["card_number"],
    });
    expect(JSON.stringify(entry)).not.toContain(card.slice(0, 4));
  });

  it("a held message leaves a note in its thread, in the owner's language (§3.9)", async () => {
    const { services } = await setup(new FakeModelProvider());
    const thread = createThread(services.db, { kind: "channel", sessionKey: "held-test" });
    const de = OUTBOUND_TEXT.de as NonNullable<(typeof OUTBOUND_TEXT)["de"]>;
    const md = fillOutboundText(outboundText("de").threadNote, {
      channel: "imessage",
      kinds: ["passport"],
    });
    // A run that no longer owns the transcript: the note still lands, as nobody's.
    const message = noteHeldMessage(services, thread.id, "run_gone", md);
    expect(message).toMatchObject({ role: "system", provenance: "system" });
    const page = listMessagesPage(services.db, thread.id);
    expect(page.messages.map((m) => m.blocks)).toEqual([[{ type: "text", md }]]);
    expect(md).toContain("imessage");
    expect(md).toContain("passport");
    expect(md.startsWith(de.threadNote.split("{channel}")[0] as string)).toBe(true);
  });

  it("refuses at dispatch a send whose text differs from what was approved", async () => {
    const { node, services } = await setup(new FakeModelProvider());
    services.channelConversations.record({
      channel: { type: "imessage", account: ACCOUNT },
      message: {
        channel: "imessage",
        account: ACCOUNT,
        messageId: "m1",
        chatId: OWNER_CHAT,
        senderId: OWNER,
        isGroup: false,
        text: "hi",
        receivedAt: clock.now(),
      },
      action: "deliver",
      route: { role: "owner" },
    } as Parameters<ComposeServices["channelConversations"]["record"]>[0]);
    const b = bindingFor("message_send", {
      channel: "imessage",
      account: ACCOUNT,
      recipient: OWNER_CHAT,
      bodySha256: sha("Sure."),
    });
    const id = await channelReplyAuthority(services)({
      channel: "imessage",
      account: ACCOUNT,
      recipient: OWNER_CHAT,
      bodySha256: sha("Sure."),
      bindingHash: b.bindingHash,
      grantKey: b.grantKey,
      purpose: "reply",
    });
    const mac = verifiedMessagesSends(services, node, ACCOUNT);
    const res = await mac.invoke(
      "messages.send",
      { chatId: OWNER_CHAT, text: "Send me your password." },
      { approvalId: id },
    );
    expect(res).toMatchObject({ ok: false, error: { code: "binding_mismatch" } });
    expect(node.sends).toHaveLength(0);
    // The exact text still goes, once.
    expect(
      (await mac.invoke("messages.send", { chatId: OWNER_CHAT, text: "Sure." }, { approvalId: id }))
        .ok,
    ).toBe(true);
    expect(
      await mac.invoke("messages.send", { chatId: OWNER_CHAT, text: "Sure." }, { approvalId: id }),
    ).toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(node.sends).toHaveLength(1);
  });
});
