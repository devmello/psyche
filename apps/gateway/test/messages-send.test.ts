import type { ToolRunContext } from "@psyche/agent-core";
import { createAuditLog } from "@psyche/audit";
import {
  bodySha256,
  createPermissionBroker,
  type PsychePermissionBroker,
} from "@psyche/permissions";
import type { MessagesChat, NodeClient, NodeInvokeOptions } from "@psyche/protocol";
import { FakeClock, FakeNotifier } from "@psyche/testing";
import { describe, expect, it, vi } from "vitest";
import { verifiedMessagesSends } from "../src/compose/channels.ts";
import { messagesSendTool, normalizeHandle } from "../src/compose/messages-send.ts";
import type { ComposeServices } from "../src/compose/services.ts";

/** `messages_send`: resolution, the compose card, the edited text that is sent, and the checks. */

const ACCOUNT = "mac-messages";
const DEVICE = { deviceId: "dev_mac" };

interface Contact {
  id: string;
  name: string;
  phones: string[];
  emails: string[];
  organization: string;
}
const person = (name: string, phones: string[] = [], emails: string[] = []): Contact => ({
  id: name,
  name,
  phones,
  emails,
  organization: "",
});
const chat = (over: Partial<MessagesChat> & { chatId: string }): MessagesChat => ({
  service: "imessage",
  displayName: null,
  isGroup: false,
  participants: [],
  lastMessageAt: null,
  lastCursor: null,
  ...over,
});

function fakeNode(contacts: Contact[], chats: MessagesChat[]) {
  const sends: { params: Record<string, unknown>; approvalId?: string }[] = [];
  const client: NodeClient = {
    nodeId: "node_mac",
    info: async () => ({}) as never,
    capabilities: async () => [],
    async invoke(capability: string, params: unknown, options: NodeInvokeOptions = {}) {
      const p = (params ?? {}) as Record<string, unknown>;
      if (capability === "contacts.search") {
        const q = String(p.query).toLowerCase();
        return {
          ok: true,
          result: { contacts: contacts.filter((c) => c.name.toLowerCase().includes(q)) },
        };
      }
      if (capability === "messages.chats") return { ok: true, result: { chats } };
      if (capability === "messages.send") {
        sends.push({
          params: p,
          ...(options.approvalId ? { approvalId: options.approvalId } : {}),
        });
        return { ok: true, result: { sent: true }, receipt: { outcome: "ok", summary: "sent" } };
      }
      return { ok: false, error: { code: "not_found", message: capability } as never };
    },
  };
  return { client, sends };
}

function setup(contacts: Contact[], chats: MessagesChat[] = [], maxPerTurn?: number) {
  const clock = new FakeClock();
  const broker: PsychePermissionBroker = createPermissionBroker({
    approvers: {
      device: async () => ({ scopes: ["operator.read", "operator.approvals"] }),
      isOwnerSender: async () => false,
    },
    clock,
    audit: createAuditLog({ clock }),
    notifier: new FakeNotifier({ clock }),
  });
  const node = fakeNode(contacts, chats);
  const issued: Awaited<ReturnType<typeof broker.requestApproval>>[] = [];
  const services = {
    rawBroker: broker,
    broker: { recordReceipt: vi.fn().mockResolvedValue(undefined) },
  } as unknown as ComposeServices;
  const tool = messagesSendTool({
    broker: {
      requestApproval: async (i: Parameters<typeof broker.requestApproval>[0]) => {
        const r = await broker.requestApproval(i);
        issued.push(r);
        return r;
      },
      awaitDecision: (id: string, signal?: AbortSignal) => broker.awaitDecision(id, signal),
    } as never,
    surfaces: ["desktop"],
    account: ACCOUNT,
    node: () => node.client,
    sender: (c) => verifiedMessagesSends(services, c, ACCOUNT),
    ...(maxPerTurn === undefined ? {} : { maxPerTurn }),
  });
  const ctx = (over: Partial<ToolRunContext> = {}): ToolRunContext =>
    ({
      callId: "call_1",
      threadId: "thr_a",
      runId: "run_1",
      taint: false,
      permissionMode: "balanced",
      mode: "interactive",
      signal: new AbortController().signal,
      onUpdate: () => undefined,
      ...over,
    }) as ToolRunContext;
  const run = (p: { to: string; text: string; service?: "imessage" | "sms" }, c = ctx()) =>
    tool.run?.(p, c) ?? Promise.reject(new Error("no run"));
  /** Answers the card once it exists. */
  const respond = async (
    decision: "approve" | "deny",
    extra: { editedText?: string; recipientChoice?: string } = {},
    scope: "once" | "always" = "once",
  ) => {
    await vi.waitFor(() => expect(issued.length).toBeGreaterThan(0));
    const i = issued[issued.length - 1];
    if (i === undefined) throw new Error("no card");
    clock.advance(500);
    return broker.answer({
      approvalId: i.approval.id,
      answerToken: i.answerTokens.desktop ?? "",
      decision,
      scope,
      ...extra,
      decidedBy: DEVICE,
    });
  };
  return { run, respond, node, issued, broker, ctx, services };
}

const compose = (i: { approval: { details: unknown } }) =>
  (
    i.approval.details as {
      compose: {
        candidates: {
          id: string;
          service: string;
          label: string;
          weak: boolean;
          participants?: string[];
        }[];
      };
    }
  ).compose;

describe("recipient resolution", () => {
  it("normalizes phones and emails and refuses other strings", () => {
    expect(normalizeHandle("(555) 123-4567")).toBe("+15551234567");
    expect(normalizeHandle("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeHandle("Dana@Example.com")).toBe("dana@example.com");
    expect(normalizeHandle("Mom")).toBeUndefined();
  });

  it("a unique contact becomes one candidate on the card with name, handle and service", async () => {
    const s = setup([person("Dana Reyes", ["+15550101"])]);
    const result = s.run({ to: "dana", text: "hi" });
    await s.respond("approve", { editedText: "hi", recipientChoice: "handle:+15550101:imessage" });
    expect((await result).output).toMatchObject({ status: "sent", to: "Dana Reyes · +15550101" });
    const c = compose(s.issued[0] as never);
    expect(c.candidates).toHaveLength(1);
    expect(c.candidates[0]).toMatchObject({ service: "imessage", weak: false });
  });

  it("two Moms (and a person with several numbers) all go on the card, none preselected", async () => {
    const s = setup([
      person("Mom", ["+15550001", "+15550002"]),
      person("Mom Jones", ["+15550003"]),
    ]);
    const result = s.run({ to: "mom", text: "hi" });
    await vi.waitFor(() => expect(s.issued.length).toBe(1));
    expect(compose(s.issued[0] as never).candidates.map((c) => c.label)).toEqual([
      "Mom · +15550001",
      "Mom · +15550002",
      "Mom Jones · +15550003",
    ]);
    // Allowing without a pick is refused; picking one sends to exactly that handle.
    await expect(s.respond("approve", { editedText: "hi" })).rejects.toMatchObject({
      code: "invalid_params",
    });
    await s.respond("approve", { editedText: "hi", recipientChoice: "handle:+15550002:imessage" });
    expect((await result).output).toMatchObject({ status: "sent" });
    expect(s.node.sends[0]?.params).toMatchObject({ to: "+15550002", text: "hi" });
  });

  it("no match returns no_match and raises no card or send", async () => {
    const s = setup([person("Dana", ["+15550101"])]);
    const out = await s.run({ to: "Zelda", text: "hi" });
    expect(out.output).toMatchObject({ status: "no_match" });
    expect(s.issued).toHaveLength(0);
    expect(s.node.sends).toHaveLength(0);
  });

  it("a number with SMS history is a weak SMS candidate; iMessage otherwise", async () => {
    const s = setup(
      [person("Sam", ["+15550201", "+15550202"])],
      [
        chat({
          chatId: "SMS;-;+15550202",
          service: "sms",
          participants: [{ handle: "+15550202", service: "sms" }],
        }),
      ],
    );
    const result = s.run({ to: "sam", text: "hi" });
    await vi.waitFor(() => expect(s.issued.length).toBe(1));
    const c = compose(s.issued[0] as never);
    expect(c.candidates.map((x) => [x.service, x.weak])).toEqual([
      ["imessage", false],
      ["sms", true],
    ]);
    await s.respond("deny");
    expect((await result).output).toMatchObject({ status: "cancelled" });
  });

  it("an existing group chat resolves by its name and is sent by chat id", async () => {
    const group = chat({
      chatId: "iMessage;+;chat123",
      displayName: "Climbing crew",
      isGroup: true,
      participants: [
        { handle: "+15550301", service: "imessage" },
        { handle: "+15550302", service: "imessage" },
      ],
    });
    const s = setup([], [group]);
    const result = s.run({ to: "climbing", text: "Saturday?" });
    await vi.waitFor(() => expect(s.issued.length).toBe(1));
    const c = compose(s.issued[0] as never);
    expect(c.candidates[0]).toMatchObject({
      label: "Climbing crew",
      participants: ["+15550301", "+15550302"],
    });
    await s.respond("approve", {
      editedText: "Saturday?",
      recipientChoice: "chat:iMessage;+;chat123",
    });
    expect((await result).output).toMatchObject({ status: "sent", to: "Climbing crew" });
    expect(s.node.sends[0]?.params).toEqual({ chatId: "iMessage;+;chat123", text: "Saturday?" });
  });
});

describe("the card and the send", () => {
  it("sends exactly the edited text, bound to the approval and spent once", async () => {
    const s = setup([person("Dana", ["+15550101"])]);
    const result = s.run({ to: "Dana", text: "draft by the agent" });
    const done = await s.respond("approve", {
      editedText: "edited by the owner\nline two",
      recipientChoice: "handle:+15550101:imessage",
    });
    const out = (await result).output as Record<string, unknown>;
    expect(out).toMatchObject({ status: "edited_and_sent", text: "edited by the owner\nline two" });
    expect(s.node.sends).toHaveLength(1);
    expect(s.node.sends[0]).toMatchObject({
      params: { to: "+15550101", text: "edited by the owner\nline two" },
      approvalId: done.id,
    });
    expect(s.services.broker.recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "node.messages.send", approvalId: done.id }),
    );
  });

  it("an unedited send says sent", async () => {
    const s = setup([person("Dana", ["+15550101"])]);
    const result = s.run({ to: "Dana", text: "same" });
    await s.respond("approve", {
      editedText: "same",
      recipientChoice: "handle:+15550101:imessage",
    });
    expect((await result).output).toMatchObject({ status: "sent" });
  });

  it("cancel sends nothing and tells the model", async () => {
    const s = setup([person("Dana", ["+15550101"])]);
    const result = s.run({ to: "Dana", text: "hi" });
    await s.respond("deny");
    expect((await result).output).toMatchObject({ status: "cancelled", sent: false });
    expect(s.node.sends).toHaveLength(0);
  });

  it("a tainted turn offers once only, refuses Always, and marks the recipient source", async () => {
    const s = setup([person("Dana", ["+15550101"])]);
    const result = s.run(
      { to: "Dana", text: "hi" },
      s.ctx({
        taint: true,
        taintSources: [{ sourceKind: "web", origin: "https://evil.example" }] as never,
      }),
    );
    await vi.waitFor(() => expect(s.issued.length).toBe(1));
    const a = s.issued[0]?.approval as NonNullable<(typeof s.issued)[number]>["approval"];
    expect(a.scopesOffered).toEqual(["once"]);
    expect(a.taint).toBe(true);
    const source = (a.details as unknown as { compose: { recipientSource: string } }).compose
      .recipientSource;
    expect(source).toBe("untrusted");
    await expect(
      s.respond(
        "approve",
        { editedText: "hi", recipientChoice: "handle:+15550101:imessage" },
        "always",
      ),
    ).rejects.toBeDefined();
    await s.respond("approve", { editedText: "hi", recipientChoice: "handle:+15550101:imessage" });
    expect((await result).output).toMatchObject({ status: "sent" });
  });

  it("the executor rejects a send that is not the one approved (binding mismatch)", async () => {
    const s = setup([person("Dana", ["+15550101"])]);
    const result = s.run({ to: "Dana", text: "approved text" });
    const done = await s.respond("approve", {
      editedText: "approved text",
      recipientChoice: "handle:+15550101:imessage",
    });
    await result;
    const guarded = verifiedMessagesSends(s.services, s.node.client, ACCOUNT);
    // The approval is spent; a swapped text or recipient against a fresh one is refused too.
    const again = await guarded.invoke(
      "messages.send",
      { to: "+15550101", text: "approved text" },
      { approvalId: done.id },
    );
    expect(again).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const s2 = setup([person("Dana", ["+15550101"])]);
    const r2 = s2.run({ to: "Dana", text: "x" });
    const d2 = await s2.respond("approve", {
      editedText: "x",
      recipientChoice: "handle:+15550101:imessage",
    });
    await r2;
    expect(bodySha256("x")).not.toBe(bodySha256("y"));
    const wrong = await verifiedMessagesSends(s2.services, s2.node.client, ACCOUNT).invoke(
      "messages.send",
      { to: "+15559999", text: "x" },
      { approvalId: d2.id },
    );
    expect(wrong).toMatchObject({ ok: false });
  });

  it("stops after the per-turn limit instead of asking again", async () => {
    const s = setup([person("Dana", ["+15550101"])], [], 1);
    const first = s.run({ to: "Dana", text: "one" });
    await s.respond("approve", { editedText: "one", recipientChoice: "handle:+15550101:imessage" });
    await first;
    const second = await s.run({ to: "Dana", text: "two" });
    expect(second.output).toMatchObject({ status: "limit" });
    expect(s.issued).toHaveLength(1);
  });

  it("refuses a non-owner requester and an unattended run", async () => {
    const s = setup([person("Dana", ["+15550101"])]);
    await expect(
      s.run({ to: "Dana", text: "hi" }, s.ctx({ requester: { role: "guest" } as never })),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      s.run({ to: "Dana", text: "hi" }, s.ctx({ mode: "unattended" })),
    ).rejects.toMatchObject({ code: "approval_required" });
  });
});
