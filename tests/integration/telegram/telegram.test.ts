import { approvalRef, type TelegramAdapter } from "@psyche/channels";
import { updateDevice } from "@psyche/db";
import { type ComposedChannels, composeChannels } from "@psyche/gateway/compose";
import type { IssuedApproval, ToolRegistration } from "@psyche/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, type Skeleton, startSkeleton } from "../walking-skeleton/harness.ts";
import { calls, MAIN, ScriptedModel, say, UTILITY } from "../walking-skeleton/scripted-model.ts";
import {
  BOT_INFO,
  BOT_USERNAME,
  FAKE_TOKEN,
  FakeBotApi,
  keyboard,
  OWNER,
  STRANGER,
} from "./fake-bot-api.ts";

/**
 * INT-2 scenario 3, CI-safe: the owner reaches Psyche from Telegram (fake Bot API, no network).
 * Pairing → owner approval from the paired desktop → a question answered in Telegram → approvals
 * that fan out to desktop + Telegram (first answer wins) → a purchase approval that never reaches
 * Telegram (security §3.7 / §9 over feature N4's "approves a purchase from Telegram").
 * Each `it` depends on the previous one.
 */

interface Approval {
  id: string;
  kind: string;
  status: string;
  surfaces: string[];
  deviceOnly: boolean;
  requestedAt: string;
  decidedBy: { channel?: string; senderId?: string; deviceId?: string } | null;
}

const ARM_MS = 450; // APPROVAL_ARM_DELAY_MS (400) plus slack
const OWNER_SURFACE = `telegram:${OWNER.id}`;
const model = new ScriptedModel();
const api = new FakeBotApi();
const sentEmails: unknown[] = [];
const purchases: unknown[] = [];
const timings: Record<string, number> = {};
let part: ComposedChannels;
let sk: Skeleton;
let c: Client;
let channelId: string;

const tools: ToolRegistration[] = [
  {
    spec: {
      name: "calendar_agenda",
      description: "List the owner's calendar events for a day.",
      inputSchema: { type: "object", properties: { day: { type: "string" } }, required: ["day"] },
      sideEffect: "read",
      provenanceOut: "untrusted",
    },
    execute: async () => ({
      output: {
        events: [
          { at: "09:00", title: "Standup" },
          { at: "13:00", title: "Dentist" },
        ],
      },
      provenance: "untrusted",
    }),
  },
  {
    spec: {
      name: "send_email",
      description: "Send an email.",
      inputSchema: {
        type: "object",
        properties: { to: { type: "string" }, subject: { type: "string" } },
        required: ["to", "subject"],
      },
      sideEffect: "write",
      targetKind: "recipient",
      provenanceOut: "trusted",
    },
    describeCall: (p) => {
      const { to, subject } = p as { to: string; subject: string };
      return {
        kind: "send_email",
        target: { kind: "recipient", value: to },
        summary: `Email ${to}: ${subject}`,
      };
    },
    execute: async (_id, params) => {
      sentEmails.push(params);
      return { output: { sent: true }, provenance: "trusted" };
    },
  },
  {
    spec: {
      name: "purchase_item",
      description: "Buy an item with the owner's saved payment method.",
      inputSchema: {
        type: "object",
        properties: { item: { type: "string" }, amountUsd: { type: "number" } },
        required: ["item", "amountUsd"],
      },
      sideEffect: "financial",
      provenanceOut: "trusted",
    },
    describeCall: (p) => {
      const { item, amountUsd } = p as { item: string; amountUsd: number };
      return { kind: "purchase", summary: `Buy ${item} for $${amountUsd}` };
    },
    execute: async (_id, params) => {
      purchases.push(params);
      return { output: { ordered: true }, provenance: "trusted" };
    },
  },
];

const bot = () => part.adapters.get(`telegram:${BOT_USERNAME}`) as TelegramAdapter;
async function ownerSays(text: string): Promise<void> {
  await bot().handleUpdate(api.dm(OWNER, text));
}

async function desktopToken(approvalId: string): Promise<string> {
  const { answerToken } = await c.call<{ answerToken?: string }>("approvals.get", { approvalId });
  if (answerToken === undefined) throw new Error("desktop has no answer token");
  return answerToken;
}

async function armed(approval: Approval): Promise<void> {
  const wait = Date.parse(approval.requestedAt) + ARM_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
  throw new Error("expected the call to be refused");
}

beforeAll(async () => {
  sk = await startSkeleton({
    model: { provider: model, model: MAIN, utilityModel: UTILITY },
    timeZone: "America/Los_Angeles",
    taskPollMs: 50,
    parts: [
      (services) => {
        for (const t of tools) services.tools.register(t);
        part = composeChannels(services, {
          telegram: {
            token: FAKE_TOKEN,
            account: BOT_USERNAME,
            options: { botInfo: BOT_INFO, transformer: api.transformer, polling: false },
          },
          healthIntervalMs: 0,
        });
        return part;
      },
    ],
  });
  c = sk.client;
  // `psyched devices grant <id> …` on the machine: the handshake secret never grants admin.
  updateDevice(sk.composed.db, sk.deviceId, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
});

afterAll(async () => {
  // Includes the deliberate wait for the card to arm (APPROVAL_ARM_DELAY_MS) before the press.
  if (Object.keys(timings).length > 0) {
    process.stdout.write(`INT-2 timings ${JSON.stringify(timings)}\n`);
  }
  await sk?.stop();
});

describe("scenario 3: Telegram (fake Bot API)", () => {
  it("the owner configures the bot from the desktop; channels.* changes need operator.admin", async () => {
    const { channel } = await c.call<{ channel: { id: string; dmPolicy: string } }>(
      "channels.configure",
      { type: "telegram", account: BOT_USERNAME, ownerIds: [String(OWNER.id)] },
      true,
    );
    channelId = channel.id;
    expect(channel.dmPolicy).toBe("pairing");
    // Ownership does not grant chat access (security §9): the owner still pairs once.
    const listed = await c.call<{ channels: { id: string }[] }>("channels.list", {});
    expect(listed.channels.map((ch) => ch.id)).toContain(channelId);

    updateDevice(sk.composed.db, sk.deviceId, {
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    });
    expect(
      await refusal(
        c.call("channels.allowlist.update", { channelId, list: "allowFrom", add: ["1"] }, true),
      ),
    ).toBe("forbidden");
    updateDevice(sk.composed.db, sk.deviceId, {
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
    });
    // Live connections pick up scopes on their next request (admin events need operator.admin).
    await c.call("channels.list", {});
  });

  it("an unknown sender (the owner, not yet allowed) gets a pairing code and nothing else", async () => {
    const from = api.mark;
    const ev = c.mark;
    await ownerSays("hi");
    const code = await api.message(OWNER.id, /pairing code is ([A-Z2-9]{8})/, from);
    const requested = await c.event<{ pairingRequest: { id: string; code: string } }>(
      "pairing.requested",
      () => true,
      ev,
    );
    expect(String(code.payload.text)).toContain(requested.pairingRequest.code);
    // No turn ran: the only message to the chat is the code.
    expect(api.sent(OWNER.id)).toHaveLength(1);
    const threads = await c.call<{ threads: { thread: { kind: string } }[] }>("threads.list", {});
    expect(threads.threads.filter((t) => t.thread.kind === "channel")).toHaveLength(0);
  });

  it("the owner approves the code with channels.pairing.approve from the paired desktop", async () => {
    const from = api.mark;
    const { requests } = await c.call<{ requests: { id: string; senderId: string }[] }>(
      "channels.pairing.list",
      { channelId, status: "pending" },
    );
    expect(requests.map((r) => r.senderId)).toEqual([String(OWNER.id)]);
    const { pairingRequest } = await c.call<{
      pairingRequest: { status: string; decidedByDeviceId: string | null };
    }>("channels.pairing.approve", { requestId: requests[0]?.id }, true);
    expect(pairingRequest).toMatchObject({ status: "approved", decidedByDeviceId: sk.deviceId });
    await api.message(OWNER.id, /You're approved/, from);
    const { channel } = await c.call<{ channel: { allowFrom: string[] } }>("channels.get", {
      channelId,
    });
    expect(channel.allowFrom).toEqual([String(OWNER.id)]);
  });

  it('"what\'s on my calendar tomorrow" → the scripted model answers → the reply goes to Telegram', async () => {
    model.chat.script([
      calls(["k1", "calendar_agenda", { day: "tomorrow" }]),
      say("Tomorrow you have **Standup** at 9:00 and the dentist at 13:00."),
    ]);
    const from = api.mark;
    const ev = c.mark;
    const t0 = Date.now();
    await ownerSays("what's on my calendar tomorrow");
    const replyCall = await api.message(OWNER.id, /Standup/, from);
    timings.telegramQuestionToReplyMs = Math.round(replyCall.at - t0);
    expect(replyCall.payload.parse_mode).toBe("HTML");
    expect(String(replyCall.payload.text)).toContain("<b>Standup</b>");
    // The turn ran on the routed thread (owner DM, per-channel-peer) and the desktop saw it.
    const msg = await c.event<{ message: { role: string; threadId: string } }>(
      "chat.message",
      (p) => p.message.role === "agent",
      ev,
    );
    const { thread } = await c.call<{ thread: { kind: string; sessionKey: string } }>(
      "threads.get",
      { threadId: msg.message.threadId },
    );
    expect(thread).toMatchObject({
      kind: "channel",
      sessionKey: `channel:telegram:${BOT_USERNAME}:dm:${OWNER.id}`,
    });
    // A typing indicator went out before the turn.
    expect(api.calls.slice(from).some((x) => x.method === "sendChatAction")).toBe(true);
  });

  it("an edit never steers: it is acknowledged and no turn starts", async () => {
    const from = api.mark;
    const ev = c.mark;
    await bot().handleUpdate(api.edit(OWNER, 4242, "actually cancel everything"));
    await api.message(OWNER.id, /Edits are not applied/, from);
    await new Promise((r) => setTimeout(r, 100));
    expect(c.events.slice(ev).some((e) => e.event === "run.updated")).toBe(false);
  });

  it("write approval: desktop + Telegram; a stranger cannot answer; Telegram answers first and wins", async () => {
    model.chat.script([
      calls(["e1", "send_email", { to: "sam@example.com", subject: "Q3 deck" }]),
      say("Sent the Q3 deck to Sam."),
    ]);
    const from = api.mark;
    const ev = c.mark;
    await ownerSays("Email Sam the Q3 deck");
    const created = await c.event<{ approval: Approval }>(
      "approval.created",
      (p) => p.approval.kind === "send_email",
      ev,
    );
    const approval = created.approval;
    const tIssued = Date.parse(approval.requestedAt);
    expect(approval.surfaces).toEqual(expect.arrayContaining(["desktop", OWNER_SURFACE]));
    expect(approval.deviceOnly).toBe(false);
    const card = await api.message(OWNER.id, (x) => keyboard(x).length > 0, from);
    timings.approvalIssuedToTelegramCardMs = Math.round(card.at - tIssued);
    expect(String(card.payload.text)).toContain("Approval needed: Send an email [write]");
    expect(JSON.stringify(card.payload)).not.toContain(approval.id);
    const lateToken = await desktopToken(approval.id);

    // A stranger pressing the owner's card (forged chat id) is refused before the broker.
    let mark = api.mark;
    await bot().handleUpdate(api.press(STRANGER, OWNER.id, card, "Approve"));
    // The refusal goes to the presser's own chat; the card stays answerable.
    await api.message(STRANGER.id, /Only the owner can answer approvals/, mark);
    expect((await sk.composed.broker.get(approval.id))?.status).toBe("pending");

    await armed(approval);
    mark = api.mark;
    const tPress = Date.now();
    // Not awaited first: the press handler also sends the (rate-limited) chat confirmation.
    const pressed = bot().handleUpdate(api.press(OWNER, OWNER.id, card, "Approve"));
    const updated = await c.event<{ approval: Approval }>(
      "approval.updated",
      (p) => p.approval.id === approval.id,
      ev,
    );
    const tDecided = Date.now();
    await pressed;
    timings.telegramPressToDesktopUpdatedMs = Math.round(tDecided - tPress);
    timings.approvalIssuedToDecidedViaTelegramMs = Math.round(tDecided - tIssued);
    expect(updated.approval.status).toBe("approved");
    expect(updated.approval.decidedBy).toMatchObject({
      channel: "telegram",
      senderId: String(OWNER.id),
    });
    await api.message(OWNER.id, /^Approved: /, mark);

    // First answer wins: the desktop's card is decided; a late desktop answer is refused.
    expect(
      await refusal(
        c.call("approvals.answer", {
          approvalId: approval.id,
          answerToken: lateToken,
          decision: "deny",
          scope: "once",
        }),
      ),
    ).toBe("answer_late");
    await api.message(OWNER.id, /Sent the Q3 deck to Sam/, from);
    expect(sentEmails).toEqual([{ to: "sam@example.com", subject: "Q3 deck" }]);
  });

  it("reverse order: the desktop answers first; the Telegram press is refused with a short reply", async () => {
    model.chat.script([
      calls(["e2", "send_email", { to: "lee@example.com", subject: "Notes" }]),
      say("Sent the notes to Lee."),
    ]);
    const from = api.mark;
    const ev = c.mark;
    await ownerSays("Email Lee the notes");
    const { approval } = await c.event<{ approval: Approval }>(
      "approval.created",
      (p) => p.approval.kind === "send_email",
      ev,
    );
    const card = await api.message(OWNER.id, (x) => keyboard(x).length > 0, from);
    const token = await desktopToken(approval.id);
    await armed(approval);
    await c.call("approvals.answer", {
      approvalId: approval.id,
      answerToken: token,
      decision: "approve",
      scope: "once",
    });
    const updated = await c.event<{ approval: Approval }>(
      "approval.updated",
      (p) => p.approval.id === approval.id,
      ev,
    );
    expect(updated.approval.decidedBy).toMatchObject({ deviceId: sk.deviceId });
    const mark = api.mark;
    await bot().handleUpdate(api.press(OWNER, OWNER.id, card, "Approve"));
    await api.message(OWNER.id, /^That approval was already answered\.$/, mark);
    await api.message(OWNER.id, /Sent the notes to Lee/, from);
    expect(sentEmails).toHaveLength(2);
  });

  it("purchase approval: never delivered to Telegram, not answerable there; the desktop needs Touch ID", async () => {
    model.chat.script([
      calls(["p1", "purchase_item", { item: "standing desk", amountUsd: 1200 }]),
      say("I did not order the standing desk."),
    ]);
    const from = api.mark;
    const ev = c.mark;
    await ownerSays("Buy the standing desk");
    const { approval } = await c.event<{ approval: Approval }>(
      "approval.created",
      (p) => p.approval.kind === "purchase",
      ev,
    );
    expect(approval.deviceOnly).toBe(true);
    expect(approval.surfaces.some((s) => s.startsWith("telegram:"))).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(api.calls.slice(from).some((x) => keyboard(x).length > 0)).toBe(false);
    expect(
      api.calls
        .slice(from)
        .some((x) => x.method === "sendMessage" && /purchase|Buy/i.test(String(x.payload.text))),
    ).toBe(false);
    // Even handed a chat token directly, the channel service refuses to deliver it.
    const forged = await part.service.deliverApproval({
      approval: {
        ...(approval as unknown as IssuedApproval["approval"]),
        surfaces: [...approval.surfaces, OWNER_SURFACE],
      },
      answerTokens: { [OWNER_SURFACE]: "at_forged" },
    });
    expect(forged).toEqual([{ surface: OWNER_SURFACE, delivered: false, reason: "device_only" }]);

    // The `/approve` fallback finds nothing to answer in chat.
    await armed(approval);
    const mark = api.mark;
    await ownerSays(`/approve ${approvalRef(approval.id)} approve`);
    await api.message(OWNER.id, /No pending approval with that ref/, mark);
    expect((await sk.composed.broker.get(approval.id))?.status).toBe("pending");

    // Only the Mac / desktop card can answer it, and approving needs a Touch ID or passkey
    // assertion. No verifier is wired yet (S14 #47, S01 #79), so the composition fails closed.
    const token = await desktopToken(approval.id);
    await expect(
      c.call("approvals.answer", {
        approvalId: approval.id,
        answerToken: token,
        decision: "approve",
        scope: "once",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await sk.composed.broker.get(approval.id))?.status).toBe("pending");
    await c.call("approvals.answer", {
      approvalId: approval.id,
      answerToken: token,
      decision: "deny",
      scope: "once",
    });
    await api.message(OWNER.id, /did not order the standing desk/, from);
    expect(purchases).toEqual([]);
  });

  it("the relay names only the owner as an approver sender", async () => {
    const relay = part.relay;
    expect(relay?.surfaces()).toEqual([OWNER_SURFACE]);
    expect(await relay?.isOwnerSender("telegram", String(OWNER.id))).toBe(true);
    expect(await relay?.isOwnerSender("telegram", String(STRANGER.id))).toBe(false);
    expect(await relay?.isOwnerSender("webchat", String(OWNER.id))).toBe(false);
  });

  it.todo(
    "a designated person's or group message runs a restricted turn (needs RouteContext in SessionController.send: S01/S02)",
  );
  it.todo(
    "the Telegram card is edited to 'answered on another device' when the desktop wins (S10: card edits not done)",
  );
});
