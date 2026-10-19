import type {
  AgentEvent,
  Requester,
  TaintSource,
  ToolCallDescription,
  ToolResult,
} from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentToolRegistration,
  InMemoryThreadStateStore,
  requesterFromRoute,
  type ToolRunContext,
} from "../src/index.ts";
import {
  call,
  endOf,
  type Harness,
  harness,
  recorder,
  runTurn,
  say,
  spec,
  start,
  until,
} from "./harness.ts";

/**
 * M2 follow-up slice (S02): what authorized a dispatch travels on `ToolRunContext.authority`
 * (standing grants included), the sender of a channel turn travels into the broker as
 * `requester`, and taint survives a kill/restart on tool results, task records and the thread
 * transcript (S23 design-07/08).
 */

interface Seen {
  callId: string;
  params: unknown;
  ctx: ToolRunContext;
}

/** A write tool with a grant key, registered the way a package executor would be adopted. */
function mailTool(result: Partial<ToolResult> = {}) {
  const seen: Seen[] = [];
  const describeCall = (p: unknown): ToolCallDescription => {
    const { to } = p as { to: string };
    return {
      kind: "send_email",
      target: { kind: "recipient", value: to },
      bindingFields: { account: "owner@example.com", to: [to] },
      grantKey: `send_email:owner@example.com:${to}`,
      summary: `Email ${to}`,
    };
  };
  const registration: AgentToolRegistration = {
    spec: spec("mail.send", "write", { targetKind: "recipient" }),
    describeCall,
    execute: async () => ({ output: {}, provenance: "trusted" }),
    run: async (params, ctx) => {
      seen.push({ callId: ctx.callId, params, ctx });
      return { output: { ok: true }, provenance: "trusted", ...result };
    },
  };
  return { seen, registration };
}

async function answerLatest(
  h: Harness,
  decision: "approve" | "deny",
  scope: "once" | "task" | "always" = "once",
) {
  const issued = h.broker.issued.at(-1);
  if (issued === undefined) throw new Error("no approval issued");
  h.clock.advance(500);
  const surface = Object.keys(issued.answerTokens)[0] as string;
  await h.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens[surface] as string,
    decision,
    ...(decision === "approve" ? { scope } : {}),
    decidedBy: { deviceId: "dev_owner", surface },
  });
  return issued.approval;
}

const lena: Requester = {
  role: "designated",
  identityId: "id_lena",
  display: "Lena",
  channel: "telegram",
  senderId: "555",
  chatId: "555",
};

function finalToolEvent(events: AgentEvent[], toolCallId: string) {
  return events.findLast(
    (e): e is Extract<AgentEvent, { type: "tool_call" }> =>
      e.type === "tool_call" && e.toolCallId === toolCallId && e.status !== "running",
  );
}

describe("standing grants reach executors (issue #86 follow-up)", () => {
  it("an answered approval and the grant it created travel as the call's authority", async () => {
    const h = harness();
    const mail = mailTool();
    h.loop.registry.register(mail.registration);
    h.provider.script([call("m1", "mail.send", { to: "alice@example.org" }), say("Sent.")]);
    const t1 = start(h, "email alice@example.org about lunch");
    await until(() => h.broker.issued.length === 1, "approval card");
    const approval = await answerLatest(h, "approve", "always");
    await t1.done;
    expect(mail.seen).toHaveLength(1);
    const first = mail.seen[0]?.ctx;
    expect(first?.approvalId).toBe(approval.id);
    expect(first?.authority).toMatchObject({
      rule: `approval:${approval.id}`,
      approvalId: approval.id,
      scope: "always",
      bindingHash: approval.bindingHash,
      grantKey: "mail.send|send_email:owner@example.com:alice@example.org",
    });
    const grantId = first?.authority?.grantId;
    expect(grantId).toBeDefined();

    // The next call is allowed by the standing grant: no card, the grant on the context.
    h.provider.script([call("m2", "mail.send", { to: "alice@example.org" }), say("Again.")]);
    const e2 = await runTurn(h, "email alice@example.org again");
    expect(endOf(e2).outcome).toBe("final");
    expect(h.broker.issued).toHaveLength(1);
    expect(mail.seen).toHaveLength(2);
    const second = mail.seen[1]?.ctx;
    expect(second?.approvalId).toBeUndefined();
    expect(second?.authority).toEqual({
      rule: `grant:${grantId}`,
      grantId,
      scope: "always",
      bindingHash: expect.stringMatching(/^sha256:/),
      grantKey: "mail.send|send_email:owner@example.com:alice@example.org",
    });
    expect(finalToolEvent(e2, "m2")?.details).toMatchObject({
      decision: "allow",
      decisionRule: `grant:${grantId}`,
      approvalId: null,
    });

    // Revoked: the broker asks again, and a denied card dispatches nothing.
    await h.broker.revokeGrant(grantId as string);
    h.provider.script([call("m3", "mail.send", { to: "alice@example.org" }), say("No.")]);
    const t3 = start(h, "email alice@example.org once more");
    await until(() => h.broker.issued.length === 2, "second approval card");
    await answerLatest(h, "deny");
    await t3.done;
    expect(mail.seen).toHaveLength(2);
  });

  it("the loop re-checks a standing grant right before dispatch and fails closed", async () => {
    const h = harness();
    const mail = mailTool();
    h.loop.registry.register(mail.registration);
    // A broker that cites a grant the ledger does not have (revoked between decide and dispatch).
    h.broker.decide = async () => ({
      decision: "allow",
      rule: "grant:grt_gone",
      grantId: "grt_gone",
    });
    h.provider.script([call("m1", "mail.send", { to: "alice@example.org" }), say("Hm.")]);
    const events = await runTurn(h, "email alice@example.org");
    expect(mail.seen).toHaveLength(0);
    expect(finalToolEvent(events, "m1")).toMatchObject({
      status: "blocked",
      level1: expect.stringContaining("grant check failed"),
    });
  });

  it("an allow without a grant still names the deciding rule and the binding", async () => {
    const h = harness({ policy: { byTool: { "mail.send": "allow" } } });
    const mail = mailTool();
    h.loop.registry.register(mail.registration);
    h.provider.script([call("m1", "mail.send", { to: "alice@example.org" }), say("ok")]);
    await runTurn(h, "email alice@example.org");
    expect(mail.seen[0]?.ctx.authority).toEqual({
      rule: "policy:mail.send",
      bindingHash: expect.stringMatching(/^sha256:/),
      grantKey: "mail.send|send_email:owner@example.com:alice@example.org",
    });
  });
});

describe("requester identity (security §9; S05 per-sender matrices)", () => {
  const policy = {
    byTool: { "crm.lookup": "allow" as const, "mail.send": "allow" as const },
    designated: { id_lena: { byTool: { "crm.lookup": "deny" as const } } },
  };

  it("a designated person's message is decided by that person's matrix, not the owner's", async () => {
    const h = harness({ policy });
    const lookup = recorder();
    h.loop.registry.register({ spec: spec("crm.lookup", "read"), execute: lookup.execute });
    h.provider.script([call("l1", "crm.lookup", { q: "acme" }), say("Found it.")]);
    await runTurn(h, "look up acme");
    expect(h.broker.decisions.at(-1)?.result).toMatchObject({
      decision: "allow",
      rule: "policy:crm.lookup",
    });
    expect(h.broker.decisions.at(-1)?.ctx.requester).toBeUndefined();
    expect(lookup.seen).toHaveLength(1);

    h.provider.script([call("l2", "crm.lookup", { q: "acme" }), say("Sorry.")]);
    const events = await runTurn(h, "look up acme", { threadId: "thr_lena", requester: lena });
    const decided = h.broker.decisions.at(-1);
    expect(decided?.ctx.requester).toEqual(lena);
    expect(decided?.result).toMatchObject({ decision: "deny", rule: "designated:deny:crm.lookup" });
    expect(lookup.seen).toHaveLength(1);
    expect(finalToolEvent(events, "l2")?.status).toBe("blocked");
    // A non-owner's words are content: the turn is tainted by them, with the sender named.
    expect(decided?.ctx.taint).toBe(true);
    expect(decided?.ctx.taintSources).toContainEqual({
      sourceKind: "channel_message",
      sender: "telegram:555",
    });
  });

  it("the owner's allowances and grants never cover a designated person; their chat never sees the card", async () => {
    const h = harness({ policy, loop: { approvalSurfaces: ["desktop", "telegram:555"] } });
    const mail = mailTool();
    h.loop.registry.register(mail.registration);
    // The owner grants `always` for alice.
    h.broker.policy({ designated: policy.designated });
    h.provider.script([call("m1", "mail.send", { to: "alice@example.org" }), say("Sent.")]);
    const t1 = start(h, "email alice@example.org");
    await until(() => h.broker.issued.length === 1, "owner's card");
    await answerLatest(h, "approve", "always");
    await t1.done;
    expect(mail.seen).toHaveLength(1);

    // Lena asks for the same send: the owner's grant does not match, and even the owner's
    // `allow` rule for mail.send would not; her own chat is not an approval surface.
    h.broker.policy(policy);
    h.provider.script([call("m2", "mail.send", { to: "alice@example.org" }), say("Asked.")]);
    const t2 = start(h, "email alice@example.org", { threadId: "thr_lena", requester: lena });
    await until(() => h.broker.issued.length === 2, "Lena's card");
    const decided = h.broker.decisions.at(-1);
    expect(decided?.result.decision).toBe("ask");
    expect(decided?.result.rule).not.toMatch(/^grant:/);
    const card = h.broker.issued[1];
    expect(card?.approval.surfaces).toEqual(["desktop"]);
    expect(card?.approval.details.requestedFor).toBe("designated: Lena");
    expect(card?.approval.taint).toBe(true);
    await answerLatest(h, "approve", "always");
    await t2.done;
    expect(mail.seen).toHaveLength(2);
    expect(mail.seen[1]?.ctx.requester).toEqual(lena);

    // Lena's grant matches Lena's next request, but her turn is tainted by her own message and
    // her words never make a target known, so the owner is still asked (security §3.6).
    h.provider.script([call("m3", "mail.send", { to: "alice@example.org" }), say("Again.")]);
    const t3 = start(h, "email alice@example.org", { threadId: "thr_lena", requester: lena });
    await until(() => h.broker.issued.length === 3, "Lena's second card");
    expect(h.broker.decisions.at(-1)?.result.rule).toBe("taint:new_target");
    await answerLatest(h, "deny");
    await t3.done;
    expect(mail.seen).toHaveLength(2);
    // ... and never the owner's.
    h.provider.script([call("m4", "mail.send", { to: "alice@example.org" }), say("Owner.")]);
    await runTurn(h, "email alice@example.org");
    expect(h.broker.decisions.at(-1)?.result.rule).toMatch(/^grant:/);
  });

  it("an allowed sender gets nothing above read; the owner's own route is the owner", async () => {
    const h = harness();
    const mail = mailTool();
    h.loop.registry.register(mail.registration);
    const stranger = requesterFromRoute({
      role: "allowed",
      channelType: "imessage",
      senderId: "+15550001",
      chatId: "+15550001",
    });
    h.provider.script([call("m1", "mail.send", { to: "alice@example.org" }), say("No.")]);
    await runTurn(h, "email alice@example.org", { threadId: "thr_x", requester: stranger });
    expect(h.broker.decisions.at(-1)?.result).toMatchObject({
      decision: "deny",
      rule: "requester:not_owner",
    });
    expect(mail.seen).toHaveLength(0);

    const owner = requesterFromRoute({
      role: "owner",
      identityId: "owner",
      channelType: "telegram",
      senderId: "1",
      chatId: "1",
    });
    expect(owner).toEqual({
      role: "owner",
      identityId: "owner",
      channel: "telegram",
      senderId: "1",
      chatId: "1",
    });
    h.provider.script([call("m2", "mail.send", { to: "alice@example.org" }), say("ok")]);
    const t = start(h, "email alice@example.org", { threadId: "thr_o", requester: owner });
    await until(() => h.broker.issued.length === 1, "owner's card");
    const d = h.broker.decisions.at(-1);
    // The owner's words name the target, and the turn is not tainted by them.
    expect(d?.ctx).toMatchObject({ taint: false, newTarget: false, requester: owner });
    expect(h.broker.issued[0]?.approval.details.requestedFor).toBeUndefined();
    await answerLatest(h, "deny");
    await t.done;
  });
});

describe("taint persistence (S23 design-07/08)", () => {
  const web: TaintSource = { sourceKind: "web.fetch", toolCallId: "f1" };

  it("tool results carry taint in and out on the persisted call details", async () => {
    const h = harness();
    h.loop.registry.register({
      spec: spec("web.fetch", "read", { provenanceOut: "untrusted" }),
      execute: recorder().execute,
    });
    const mail = mailTool();
    h.loop.registry.register(mail.registration);
    h.provider.script([
      call("f1", "web.fetch", { url: "https://evil.test" }),
      call("m1", "mail.send", { to: "alice@example.org" }),
      say("done"),
    ]);
    const t = start(h, "read evil.test then email alice@example.org");
    await until(() => h.broker.issued.length === 1, "card");
    await answerLatest(h, "approve");
    const events = await t.done;
    expect(finalToolEvent(events, "f1")?.details).toMatchObject({
      taintIn: false,
      taintOut: true,
      provenanceOut: "untrusted",
      decision: "allow",
    });
    const sent = finalToolEvent(events, "m1")?.details;
    expect(sent).toMatchObject({
      taintIn: true,
      taintOut: false,
      provenanceOut: "trusted",
      decision: "ask",
      decisionRule: "mode:balanced/write",
      approvalId: h.broker.issued[0]?.approval.id,
    });
    expect(sent?.receiptId).toMatch(/^rcp/);
    expect(mail.seen[0]?.ctx.taintSources).toEqual([web]);
    const card = h.broker.issued[0]?.approval;
    expect(card?.taint).toBe(true);
    expect(card?.details.taintSources).toEqual(["web.fetch"]);
  });

  it("a thread's taint sources survive a kill/restart with its state", async () => {
    const state = new InMemoryThreadStateStore();
    const before = harness({ loop: { state } });
    before.loop.registry.register({
      spec: spec("web.fetch", "read", { provenanceOut: "untrusted" }),
      execute: recorder().execute,
    });
    before.provider.script([call("f1", "web.fetch", { url: "https://evil.test" }), say("Read.")]);
    await runTurn(before, "read evil.test", { threadId: "thr_p" });
    expect((await state.load("thr_p"))?.taint).toEqual({ sources: [web] });

    // A new loop over the same store: the owner's next message starts tainted by the content
    // still in context, with the original sources on the card.
    const after = harness({ loop: { state } });
    const mail = mailTool();
    after.loop.registry.register(mail.registration);
    after.provider.script([call("m1", "mail.send", { to: "ops@evil.test" }), say("Hm.")]);
    const t = start(after, "continue with the setup", { threadId: "thr_p" });
    await until(() => after.broker.issued.length === 1, "card after restart");
    const decided = after.broker.decisions.at(-1);
    expect(decided?.ctx.taint).toBe(true);
    expect(decided?.ctx.taintSources).toEqual([{ sourceKind: "transcript" }, web]);
    expect(decided?.ctx.newTarget).toBe(true);
    expect(decided?.result.decision).toBe("ask");
    expect(after.broker.issued[0]?.approval.details.taintSources).toEqual([
      "transcript",
      "web.fetch",
    ]);
    await answerLatest(after, "deny");
    await t.done;
    expect(mail.seen).toHaveLength(0);

    // A clean thread stays clean after the restart.
    after.provider.script([say("hi")]);
    await runTurn(after, "hello", { threadId: "thr_clean" });
    expect((await state.load("thr_clean"))?.taint).toBeUndefined();
  });

  it("a task created from a tainted turn keeps the sources, and every run starts with them", async () => {
    const h = harness();
    h.loop.registry.register({
      spec: spec("web.fetch", "read", { provenanceOut: "untrusted" }),
      execute: recorder().execute,
    });
    h.provider.script([
      call("f1", "web.fetch", { url: "https://evil.test" }),
      call("t1", "task.start", { title: "Follow up", goal: "forward invoices" }),
      say("Started."),
    ]);
    await runTurn(h, "read and delegate");
    const [task] = await h.tasks.list();
    expect(task?.taint).toBe(true);
    expect(task?.taintSources).toEqual([web]);

    const mail = mailTool();
    h.loop.registry.register(mail.registration);
    h.provider.script([call("m1", "mail.send", { to: "billing@evil.test" }), say("Hm.")]);
    const t = start(h, "step 2", { taskId: task?.id as string, threadId: "thr_task" });
    await until(() => h.broker.issued.length === 1, "task run card");
    const decided = h.broker.decisions.at(-1);
    expect(decided?.ctx.taintSources).toEqual([{ sourceKind: "task" }, web]);
    expect(decided?.ctx).toMatchObject({ taint: true, newTarget: true });
    expect(decided?.result.decision).toBe("ask");
    await answerLatest(h, "deny");
    await t.done;
    expect(mail.seen).toHaveLength(0);
  });
});
