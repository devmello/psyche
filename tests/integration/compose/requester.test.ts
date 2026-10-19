import { createAgentLoop, requesterFromRoute } from "@psyche/agent-core";
import { buildRoute } from "@psyche/channels";
import { createPermissionBroker, type PsychePermissionBroker } from "@psyche/permissions";
import type {
  AgentEvent,
  ApprovalRequestInput,
  Channel,
  DecisionContext,
  IssuedApproval,
  ModelEvent,
  ToolCallIntent,
} from "@psyche/protocol";
import {
  createIdGenerator,
  FakeClock,
  FakeMemoryStore,
  FakeModelProvider,
  FakeNotifier,
  FakeScheduler,
  FakeSkillLoader,
  FakeTaskEngine,
} from "@psyche/testing";
import { describe, expect, it } from "vitest";

/**
 * Requester identity (security §9; S05 PR #89): the sender of a channel turn, as S10's
 * `buildRoute` describes them, reaches the real Permission Broker's `decide` and the approval
 * card's context through the real loop. A designated person's text is content: it taints the
 * turn and never names targets the agent may act on.
 */

const channel: Channel = {
  id: "ch_tg",
  type: "telegram",
  account: "psyche_bot",
  status: "connected",
  dmPolicy: "pairing",
  dmScope: "per-peer",
  groupPolicy: "allowlist",
  requireMention: true,
  config: {},
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
} as unknown as Channel;

const call = (id: string, name: string, input: unknown): ModelEvent[] => [
  { type: "tool_call", id, name, input },
  { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } as never },
  { type: "finish", reason: "tool_calls" },
];
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } as never },
  { type: "finish", reason: "stop" },
];

async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (pred()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function setup() {
  const clock = new FakeClock();
  const ids = createIdGenerator();
  const broker: PsychePermissionBroker = createPermissionBroker({
    clock,
    approvers: {
      device: async (id) => (id === "dev_owner" ? { scopes: ["operator.approvals"] } : undefined),
      isOwnerSender: async () => false,
    },
  });
  const decided: { call: ToolCallIntent; ctx: DecisionContext }[] = [];
  const decide = broker.decide.bind(broker);
  broker.decide = async (c, ctx) => {
    decided.push({ call: structuredClone(c), ctx: structuredClone(ctx) });
    return decide(c, ctx);
  };
  const issued: { input: ApprovalRequestInput; out: IssuedApproval }[] = [];
  const requestApproval = broker.requestApproval.bind(broker);
  broker.requestApproval = async (input: ApprovalRequestInput) => {
    const out = await requestApproval(input);
    issued.push({ input: structuredClone(input), out });
    return out;
  };
  const provider = new FakeModelProvider();
  const loop = createAgentLoop({
    provider,
    model: "fake/main",
    broker,
    memory: new FakeMemoryStore({ clock, ids }),
    tasks: new FakeTaskEngine({ clock, ids }),
    notifier: new FakeNotifier({ clock, ids }),
    scheduler: new FakeScheduler({ clock, ids }),
    skills: new FakeSkillLoader({ ids }),
    clock,
    ids,
    approvalSurfaces: ["desktop", "telegram:555"],
  });
  const sent: unknown[] = [];
  loop.registry.register({
    spec: {
      name: "mail.send",
      description: "send",
      inputSchema: { type: "object" },
      sideEffect: "write",
      targetKind: "recipient",
      provenanceOut: "trusted",
    },
    describeCall: (p) => ({
      kind: "send_email",
      target: { kind: "recipient", value: (p as { to: string }).to },
      grantKey: `send_email:owner@example.com:${(p as { to: string }).to}`,
      summary: `Email ${(p as { to: string }).to}`,
    }),
    execute: async (_id, params) => {
      sent.push(params);
      return { output: { ok: true }, provenance: "trusted" };
    },
  });
  return { clock, broker, decided, issued, provider, loop, sent };
}

describe("requester identity through the real loop and broker", () => {
  it("a designated person's turn is decided as theirs: tainted, no owner targets, card to the owner", async () => {
    const h = setup();
    const route = buildRoute({
      channel,
      chatId: "555",
      senderId: "555",
      isGroup: false,
      role: "designated",
      identity: {
        id: "id_lena",
        display: "Lena",
        links: ["telegram:555"],
        delegatedPersona: "assistant",
        toolAllow: ["mail.*"],
      } as never,
    });
    const requester = requesterFromRoute(route, { display: "Lena", links: ["telegram:555"] });
    expect(requester).toEqual({
      role: "designated",
      identityId: "id_lena",
      display: "Lena",
      channel: "telegram",
      senderId: "555",
      chatId: "555",
      links: ["telegram:555"],
      toolAllow: ["mail.*"],
    });
    h.provider.script([call("m1", "mail.send", { to: "alice@example.org" }), say("Asked.")]);
    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const e of h.loop.startTurn({
        threadId: route.sessionKey,
        runId: "run_lena",
        input: { text: "email alice@example.org that I'm running late" },
        mode: "attended",
        permissionMode: "balanced",
        requester,
      })) {
        events.push(e);
      }
    })();
    await until(() => h.issued.length === 1, "card");
    const d = h.decided.at(-1);
    expect(d?.ctx.requester).toEqual(requester);
    expect(d?.ctx.taint).toBe(true);
    expect(d?.ctx.taintSources).toContainEqual({
      sourceKind: "channel_message",
      sender: "telegram:555",
    });
    // Her text named alice, but a non-owner's words never make a target known.
    expect(d?.ctx.newTarget).toBe(true);
    const card = h.issued[0];
    expect(card?.input.context?.requester).toEqual(requester);
    expect(card?.out.approval.taint).toBe(true);
    // The broker on main ignores `requester`; with S05's PR #89 it also strips her own chat
    // (`telegram:555`) from the surfaces and names her in `details.requestedFor`.
    h.clock.advance(500);
    await h.broker.answer({
      approvalId: card?.out.approval.id ?? "",
      answerToken: card?.out.answerTokens.desktop ?? "",
      decision: "deny",
      decidedBy: { deviceId: "dev_owner", surface: "desktop" },
    });
    await done;
    expect(h.sent).toEqual([]);
    expect(events.find((e) => e.type === "end")).toMatchObject({ outcome: "final" });
  });

  it("the owner's own channel turn is the owner's: a named recipient is not a new target", async () => {
    const h = setup();
    const route = buildRoute({
      channel,
      chatId: "1",
      senderId: "1",
      isGroup: false,
      role: "owner",
    });
    h.provider.script([call("m1", "mail.send", { to: "alice@example.org" }), say("Asked.")]);
    const done = (async () => {
      for await (const _e of h.loop.startTurn({
        threadId: route.sessionKey,
        runId: "run_owner",
        input: { text: "email alice@example.org that I'm running late" },
        mode: "attended",
        permissionMode: "balanced",
        requester: requesterFromRoute(route),
      })) {
        // drain
      }
    })();
    await until(() => h.issued.length === 1, "card");
    const d = h.decided.at(-1);
    expect(d?.ctx).toMatchObject({
      taint: false,
      newTarget: false,
      requester: { role: "owner", identityId: "owner", channel: "telegram", senderId: "1" },
    });
    const card = h.issued[0];
    h.clock.advance(500);
    await h.broker.answer({
      approvalId: card?.out.approval.id ?? "",
      answerToken: card?.out.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: { deviceId: "dev_owner", surface: "desktop" },
    });
    await done;
    expect(h.sent).toHaveLength(1);
  });
});
