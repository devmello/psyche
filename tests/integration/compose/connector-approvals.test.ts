import {
  type AgentToolRegistration,
  createAgentLoop,
  type ToolRunContext,
} from "@psyche/agent-core";
import {
  type CatalogueEntry,
  type ConnectorFactory,
  ConnectorRegistry,
  sha256 as connectorSha256,
} from "@psyche/connectors";
import { createPermissionBroker, type PsychePermissionBroker } from "@psyche/permissions";
import type {
  AgentEvent,
  ApprovalRequestInput,
  IssuedApproval,
  ModelEvent,
  ToolRegistration,
  ToolRegistry,
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
 * Issue #78 (found by INT-2): a first-party connector write (`mcp__<connector>__<tool>`, kind from
 * `describeCall`) must reach an approval card, dispatch once after "Allow once", and leave a
 * receipt. This runs the real agent loop, the real Permission Broker and the real connector
 * registry; only the model and the provider are scripted.
 */

const entry: CatalogueEntry = {
  type: "mail",
  id: "mail",
  label: "Mail",
  description: "test mail connector",
  category: "first_party",
  vendor: "Psyche",
  auth: "none",
  scopes: { read: ["r"], read_act: ["r", "w"] },
  actions: [{ id: "mail.send", title: "Send", sideEffect: "destructive", defaultRule: "ask" }],
  available: true,
};

function mailFactory(sent: unknown[]): ConnectorFactory {
  return {
    entry,
    create: (record) => ({
      id: record.id,
      type: "mail",
      connect: async () => ({ account: "owner@example.com", scopes: ["r", "w"] }),
      disconnect: async () => {},
      actions: () => entry.actions,
      tools: () => [
        {
          name: "send",
          action: "mail.send",
          description: "send an email",
          inputSchema: { type: "object" },
          sideEffect: "destructive",
          describeCall: (params: unknown) => {
            const p = params as { to: string; subject: string; body: string };
            return {
              kind: "send_email" as const,
              sideEffect: "destructive" as const,
              target: { kind: "recipient" as const, value: p.to },
              bindingFields: {
                account: "owner@example.com",
                to: [p.to],
                subject: p.subject,
                bodySha256: connectorSha256(p.body),
              },
              grantKey: `send_email:owner@example.com:${p.to}`,
              summary: `Send "${p.subject}" to ${p.to}`,
            };
          },
          execute: async (params: unknown) => {
            sent.push(params);
            return {
              output: { id: "msg-1" },
              provenance: "untrusted",
              externalRefs: { messageId: "msg-1" },
            };
          },
        },
      ],
      health: async () => ({ ok: true, status: "connected", checkedAt: 0 }),
    }),
  };
}

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
  // Generous tick bound plus a wall-clock limit: CI runners under load need far more than a few
  // thousand event-loop turns for real I/O.
  const deadline = Date.now() + 15_000;
  for (let i = 0; i < 200_000; i += 1) {
    if (pred()) return;
    if (Date.now() > deadline) break;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function setup() {
  const clock = new FakeClock();
  const ids = createIdGenerator();
  const issued: IssuedApproval[] = [];
  const broker: PsychePermissionBroker = createPermissionBroker({
    clock,
    approvers: {
      device: async (id) => (id === "dev_owner" ? { scopes: ["operator.approvals"] } : undefined),
      isOwnerSender: async () => false,
    },
  });
  const requestApproval = broker.requestApproval.bind(broker);
  broker.requestApproval = async (input: ApprovalRequestInput) => {
    const out = await requestApproval(input);
    issued.push(out);
    return out;
  };
  const sent: unknown[] = [];
  const message = { to: "alice@example.org", subject: "Lunch", body: "Friday works." };
  const provider = new FakeModelProvider().script([
    call("c1", "mcp__mail-1__send", message),
    say("Sent."),
  ]);
  const loop = createAgentLoop({
    provider,
    model: "fake/main",
    utilityModel: "fake/utility",
    broker,
    memory: new FakeMemoryStore({ clock, ids }),
    tasks: new FakeTaskEngine({ clock, ids }),
    notifier: new FakeNotifier({ clock, ids }),
    scheduler: new FakeScheduler({ clock, ids }),
    skills: new FakeSkillLoader({ ids }),
    clock,
    ids,
  });
  // The Gateway's call-context adapter: executors learn the approval the loop obtained.
  const contexts = new Map<string, ToolRunContext>();
  const tools: ToolRegistry = {
    list: () => [],
    get: () => undefined,
    register: (r: ToolRegistration) => {
      const reg: AgentToolRegistration = {
        ...r,
        run: async (params, ctx) => {
          contexts.set(ctx.callId, ctx);
          try {
            return await r.execute(ctx.callId, params, ctx.signal, ctx.onUpdate);
          } finally {
            contexts.delete(ctx.callId);
          }
        },
      };
      return loop.registry.register(reg);
    },
  };
  const connectors = new ConnectorRegistry({
    factories: [mailFactory(sent)],
    context: {
      clock,
      fetch,
      tokens: { load: async () => undefined, save: async () => {}, clear: async () => {} },
    },
    tools,
    broker,
    approvalFor: (callId) => contexts.get(callId)?.approvalId,
    newId: () => "mail-1",
  });
  await connectors.connect({ catalogueId: "mail", scopeMode: "read_act" });
  return { clock, broker, loop, issued, sent, message };
}

describe("connector writes through the loop (issue #78)", () => {
  it("ask → card → Allow once → one send and a receipt", async () => {
    const h = await setup();
    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const e of h.loop.startTurn({
        threadId: "thr_1",
        runId: "run_1",
        input: { text: "email alice@example.org that Friday works" },
        mode: "attended",
        permissionMode: "balanced",
      })) {
        events.push(e);
      }
    })();
    await until(() => h.issued.length === 1, "approval card");
    const card = h.issued[0];
    expect(card?.approval).toMatchObject({
      kind: "send_email",
      status: "pending",
      deviceOnly: true,
    });
    expect(h.sent).toHaveLength(0);
    h.clock.advance(500);
    await h.broker.answer({
      approvalId: card?.approval.id ?? "",
      answerToken: card?.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: { deviceId: "dev_owner", surface: "desktop" },
    });
    await done;
    expect(h.sent).toEqual([h.message]);
    const receipts = await h.broker.listReceipts({ toolCallId: "c1" });
    expect(receipts.map((r) => [r.kind, r.outcome, r.approvalId])).toContainEqual([
      "mail.send",
      "ok",
      card?.approval.id,
    ]);
    const end = events.find((e) => e.type === "end");
    expect(end).toMatchObject({ outcome: "final" });
    // The once approval was consumed by the loop and cannot authorize another dispatch.
    expect(
      await h.broker.verifyBinding(card?.approval.id ?? "", card?.approval.bindingHash ?? ""),
    ).toEqual({
      ok: false,
      reason: "consumed",
    });
  });

  it("a denied card sends nothing", async () => {
    const h = await setup();
    const done = (async () => {
      for await (const _e of h.loop.startTurn({
        threadId: "thr_1",
        runId: "run_2",
        input: { text: "email alice@example.org that Friday works" },
        mode: "attended",
        permissionMode: "balanced",
      })) {
        // drain
      }
    })();
    await until(() => h.issued.length === 1, "approval card");
    h.clock.advance(500);
    const card = h.issued[0];
    await h.broker.answer({
      approvalId: card?.approval.id ?? "",
      answerToken: card?.answerTokens.desktop ?? "",
      decision: "deny",
      decidedBy: { deviceId: "dev_owner", surface: "desktop" },
    });
    await done;
    expect(h.sent).toEqual([]);
  });
});
