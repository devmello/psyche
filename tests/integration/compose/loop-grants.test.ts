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
 * Standing grants on connector writes (PR #86 note, S02 M2 follow-up): a connector write allowed
 * by a `task` grant used to fail in the connector registry with `approval_required`, because the
 * loop only handed executors an approval id. Now the loop puts what authorized the call on
 * `ToolRunContext.authority` and the registry confirms the grant the way it confirms an
 * approval. Real agent loop, real Permission Broker, real connector registry; only the model and
 * the provider are scripted.
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

interface Sent {
  params: unknown;
  authority: unknown;
}

function mailFactory(sent: Sent[]): ConnectorFactory {
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
          execute: async (params: unknown, ctx) => {
            sent.push({ params, authority: ctx.authority ?? null });
            return {
              output: { id: `msg-${sent.length}` },
              provenance: "untrusted",
              externalRefs: { messageId: `msg-${sent.length}` },
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
  for (let i = 0; i < 2000; i += 1) {
    if (pred()) return;
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
  const sent: Sent[] = [];
  const provider = new FakeModelProvider();
  const tasks = new FakeTaskEngine({ clock, ids });
  const loop = createAgentLoop({
    provider,
    model: "fake/main",
    utilityModel: "fake/utility",
    broker,
    memory: new FakeMemoryStore({ clock, ids }),
    tasks,
    notifier: new FakeNotifier({ clock, ids }),
    scheduler: new FakeScheduler({ clock, ids }),
    skills: new FakeSkillLoader({ ids }),
    clock,
    ids,
    evaluator: { enabled: false },
  });
  // The Gateway's call-context adapter: executors learn what authorized the call.
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
    authorityFor: (callId) => contexts.get(callId)?.authority,
    newId: () => "mail-1",
  });
  await connectors.connect({ catalogueId: "mail", scopeMode: "read_act" });
  let runs = 0;
  const turn = async (
    text: string,
    script: ModelEvent[][],
    taskId: string,
    onCard?: () => Promise<void>,
  ) => {
    runs += 1;
    provider.script(script);
    const events: AgentEvent[] = [];
    const cards = issued.length;
    const done = (async () => {
      for await (const e of loop.startTurn({
        threadId: "thr_1",
        runId: `run_${runs}`,
        taskId,
        input: { text },
        mode: "attended",
        permissionMode: "balanced",
      })) {
        events.push(e);
      }
    })();
    if (onCard !== undefined) {
      await until(() => issued.length === cards + 1, "approval card");
      await onCard();
    }
    await done;
    return events;
  };
  const approve = async (scope: "once" | "task") => {
    const card = issued.at(-1);
    clock.advance(500);
    await broker.answer({
      approvalId: card?.approval.id ?? "",
      answerToken: card?.answerTokens.desktop ?? "",
      decision: "approve",
      scope,
      decidedBy: { deviceId: "dev_owner", surface: "desktop" },
    });
  };
  await tasks.create({ threadId: "thr_1", title: "Lunch", goal: "plan", createdFrom: "chat" });
  await tasks.create({ threadId: "thr_1", title: "Other", goal: "x", createdFrom: "chat" });
  const [task1, task2] = (await tasks.list()).map((t) => t.id) as [string, string];
  return { clock, broker, issued, sent, turn, approve, task1, task2 };
}

const toAlice = (subject: string) => ({
  to: "alice@example.org",
  subject,
  body: `About ${subject}.`,
});

describe("connector writes allowed by a standing task grant", () => {
  it("'Allow for this task' covers the task's later sends without a card, until revoked", async () => {
    const h = await setup();
    const e1 = await h.turn(
      "email alice@example.org about lunch",
      [call("c1", "mcp__mail-1__send", toAlice("Lunch")), say("Sent.")],
      h.task1,
      () => h.approve("task"),
    );
    expect(e1.find((e) => e.type === "end")).toMatchObject({ outcome: "final" });
    const card = h.issued[0]?.approval;
    expect(card?.scopesOffered).toEqual(["once", "task"]);
    const grantId = (await h.broker.get(card?.id ?? ""))?.grantId;
    expect(grantId).toMatch(/^grt/);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.authority).toMatchObject({
      approvalId: card?.id,
      grantId,
      scope: "task",
    });

    // A different email to the same recipient in the same task: the grant key matches, the
    // binding differs, no card, and the registry dispatches on the grant with a receipt.
    const e2 = await h.turn(
      "email alice@example.org about dinner too",
      [call("c2", "mcp__mail-1__send", toAlice("Dinner")), say("Sent again.")],
      h.task1,
    );
    expect(e2.find((e) => e.type === "end")).toMatchObject({ outcome: "final" });
    expect(h.issued).toHaveLength(1);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.authority).toEqual({
      rule: `grant:${grantId}`,
      bindingHash: expect.stringMatching(/^sha256:/),
      grantKey: "mcp__mail-1__send|send_email:owner@example.com:alice@example.org",
      grantId,
      scope: "task",
    });
    const receipts = await h.broker.listReceipts({ toolCallId: "c2" });
    expect(receipts.map((r) => [r.kind, r.outcome, r.approvalId])).toContainEqual([
      "mail.send",
      "ok",
      null,
    ]);
    const final = e2.findLast(
      (e): e is Extract<AgentEvent, { type: "tool_call" }> =>
        e.type === "tool_call" && e.toolCallId === "c2",
    );
    // The first send's result was third-party content, so this turn started tainted; alice is
    // in the owner's words, so the grant still applies.
    expect(final?.details).toMatchObject({
      decision: "allow",
      decisionRule: `grant:${grantId}`,
      taintIn: true,
      taintOut: true,
    });
    expect(final?.details?.receiptId).toMatch(/^rcp/);

    // Another task: the task grant does not apply, so the owner is asked again.
    await h.turn(
      "email alice@example.org about the other thing",
      [call("c3", "mcp__mail-1__send", toAlice("Other")), say("Hm.")],
      h.task2,
      async () => {
        const card3 = h.issued.at(-1);
        h.clock.advance(500);
        await h.broker.answer({
          approvalId: card3?.approval.id ?? "",
          answerToken: card3?.answerTokens.desktop ?? "",
          decision: "deny",
          decidedBy: { deviceId: "dev_owner", surface: "desktop" },
        });
      },
    );
    expect(h.issued).toHaveLength(2);
    expect(h.sent).toHaveLength(2);

    // Revoked: the first task asks again too.
    await h.broker.revokeGrant(grantId as string);
    await h.turn(
      "email alice@example.org about brunch",
      [call("c4", "mcp__mail-1__send", toAlice("Brunch")), say("Hm.")],
      h.task1,
      async () => {
        const card4 = h.issued.at(-1);
        h.clock.advance(500);
        await h.broker.answer({
          approvalId: card4?.approval.id ?? "",
          answerToken: card4?.answerTokens.desktop ?? "",
          decision: "deny",
          decidedBy: { deviceId: "dev_owner", surface: "desktop" },
        });
      },
    );
    expect(h.issued).toHaveLength(3);
    expect(h.sent).toHaveLength(2);
  });

  it("a tainted turn still asks for a new recipient the grant does not name", async () => {
    const h = await setup();
    await h.turn(
      "email alice@example.org about lunch",
      [call("c1", "mcp__mail-1__send", toAlice("Lunch")), say("Sent.")],
      h.task1,
      () => h.approve("task"),
    );
    // The connector's own result is untrusted, so the next send in this thread is tainted:
    // a recipient the owner did not name asks (security §3.6), even with the task grant live.
    await h.turn(
      "now email bob too",
      [
        call("c2", "mcp__mail-1__send", { to: "bob@example.org", subject: "Hi", body: "Hi" }),
        say("Asked."),
      ],
      h.task1,
      async () => {
        const card = h.issued.at(-1);
        expect(card?.approval.taint).toBe(true);
        expect(card?.approval.details.taintSources).toContainEqual(
          expect.stringContaining("mcp__mail-1__send"),
        );
        h.clock.advance(500);
        await h.broker.answer({
          approvalId: card?.approval.id ?? "",
          answerToken: card?.answerTokens.desktop ?? "",
          decision: "deny",
          decidedBy: { deviceId: "dev_owner", surface: "desktop" },
        });
      },
    );
    expect(h.sent).toHaveLength(1);
  });
});
