import { type AgentToolRegistration, defineTool, type ToolRunContext } from "@psyche/agent-core";
import { createPermissionBroker } from "@psyche/permissions";
import { type ActionCall, ActionProposal } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { createProposalHandlers, type ProposalEvent, ProposalService } from "../src/index.ts";
import { T0, testDb } from "./helpers.ts";

/** Batch proposals end to end on the real Permission Broker (#670 W2, spec §8.1, §4.1 case 2). */

interface Ran {
  tool: string;
  params: unknown;
  authority: ToolRunContext["authority"];
  taint: boolean;
}

function rig() {
  const clock = new FakeClock(T0);
  const db = testDb(clock);
  const broker = createPermissionBroker({
    clock,
    approvers: {
      device: async (id) => (id === "dev_mac" ? { scopes: ["operator.approvals"] } : undefined),
      isOwnerSender: async () => false,
    },
  });
  const ran: Ran[] = [];
  let failOn: string | null = null;
  const record = (tool: string) => async (params: unknown, ctx: ToolRunContext) => {
    if (failOn !== null && JSON.stringify(params).includes(failOn))
      throw new Error("message moved");
    ran.push({ tool, params, authority: ctx.authority, taint: ctx.taint });
    return { output: { ok: true }, provenance: "trusted" as const };
  };
  const tools = new Map<string, AgentToolRegistration>([
    [
      "mail_set_flags",
      defineTool({
        name: "mail_set_flags",
        description: "Mark read / flag",
        input: Type.Object({ ids: Type.Array(Type.String()), read: Type.Optional(Type.Boolean()) }),
        sideEffect: "write",
        run: record("mail_set_flags"),
      }),
    ],
    [
      "reminders_create",
      defineTool({
        name: "reminders_create",
        description: "Create a reminder",
        input: Type.Object({ title: Type.String() }),
        sideEffect: "write",
        run: record("reminders_create"),
      }),
    ],
    [
      "notes_create",
      defineTool({
        name: "notes_create",
        description: "Create a note",
        input: Type.Object({ title: Type.String(), body: Type.String() }),
        sideEffect: "write",
        // What the Apple connector describes (security §3.5): a Prep: title is its own class.
        describeCall: (p) => ({
          kind: "connector_action",
          target: { kind: "account", value: "apple-notes" },
          bindingFields: { connectorId: "apple-notes", tool: "notes_create" },
          grantKey: `connector_action:apple-notes:notes_create${
            String(p.title).startsWith("Prep:") ? ":title-prefix:Prep:" : ""
          }`,
        }),
        run: record("notes_create"),
      }),
    ],
    [
      "mail_send_draft",
      defineTool({
        name: "mail_send_draft",
        description: "Send a draft",
        input: Type.Object({ draftId: Type.String() }),
        sideEffect: "destructive",
        run: record("mail_send_draft"),
      }),
    ],
    [
      "mail_send_as_write",
      defineTool({
        name: "mail_send_as_write",
        description: "A mislabelled send",
        input: Type.Object({ to: Type.String() }),
        sideEffect: "write",
        describeCall: (p) => ({ kind: "send_email", target: { kind: "recipient", value: p.to } }),
        run: record("mail_send_as_write"),
      }),
    ],
  ]);
  const events: ProposalEvent[] = [];
  let n = 0;
  const proposals = new ProposalService({
    db: db.sqlite,
    clock,
    broker,
    tools: { get: (name) => tools.get(name) },
    mainThread: async () => "thr_main",
    newId: () => `prop_${++n}`,
    onEvent: (e) => events.push(e),
  });
  const answer = async (
    approvalId: string,
    token: string,
    decision: "approve" | "deny" = "approve",
  ) => {
    clock.advance(500);
    return broker.answer({
      approvalId,
      answerToken: token,
      decision,
      scope: "once",
      decidedBy: { deviceId: "dev_mac", surface: "desktop" },
    });
  };
  return {
    clock,
    db,
    broker,
    proposals,
    ran,
    events,
    answer,
    failOn: (s: string | null) => (failOn = s),
  };
}

const newsletters = (n: number): ActionCall[] =>
  Array.from({ length: n }, (_, i) => ({
    tool: "mail_set_flags",
    params: { ids: [`m${i + 1}`], read: true },
    summary: `Mark read: newsletter ${i + 1}`,
  }));

describe("batch proposals (W2)", () => {
  it("one card for 12 calls; approving runs exactly those 12, each under its own child approval", async () => {
    const r = rig();
    const p = r.proposals.create({
      title: "Mark 12 newsletters read",
      calls: newsletters(12),
      createdBy: { job: "mail.digest" },
      postId: "post_1",
    });
    expect(Value.Check(ActionProposal, p)).toBe(true);
    const { proposal, issued } = await r.proposals.approve(p.id);
    expect(proposal.status).toBe("awaiting_approval");
    expect(issued.approval).toMatchObject({
      kind: "batch",
      scopesOffered: ["once"],
      summary: "Mark 12 newsletters read",
    });
    expect((issued.approval.details as { calls: string[] }).calls).toHaveLength(12);
    expect(r.ran).toEqual([]);
    await r.answer(issued.approval.id, issued.answerTokens.desktop ?? "");
    await r.proposals.idle();
    expect(r.ran.map((x) => (x.params as { ids: string[] }).ids[0])).toEqual(
      newsletters(12).map((c) => (c.params as { ids: string[] }).ids[0]),
    );
    expect(new Set(r.ran.map((x) => x.authority?.approvalId)).size).toBe(12);
    expect(
      r.ran.every(
        (x) => x.authority?.scope === "once" && x.authority.approvalId !== issued.approval.id,
      ),
    ).toBe(true);
    const done = r.proposals.get(p.id);
    expect(done.status).toBe("done");
    expect(done.results?.every((x) => x.status === "ok" && x.receiptId !== undefined)).toBe(true);
    expect(r.events.map((e) => e.payload.proposal.status)).toEqual([
      "pending",
      "awaiting_approval",
      "running",
      "done",
    ]);
  });

  it("a denied card runs nothing and dismisses the proposal", async () => {
    const r = rig();
    const p = r.proposals.create({
      title: "Archive 2",
      calls: newsletters(2),
      createdBy: { job: "mail.digest" },
    });
    const { issued } = await r.proposals.approve(p.id);
    await r.answer(issued.approval.id, issued.answerTokens.desktop ?? "", "deny");
    await r.proposals.idle();
    expect(r.ran).toEqual([]);
    expect(r.proposals.get(p.id).status).toBe("dismissed");
  });

  it("refuses destructive tools at create and sends at approve, even when declared as writes", async () => {
    const r = rig();
    expect(() =>
      r.proposals.create({
        title: "Send",
        calls: [{ tool: "mail_send_draft", params: { draftId: "d1" }, summary: "Send" }],
        createdBy: { job: "x" },
      }),
    ).toThrow(expect.objectContaining({ code: "policy_denied" }));
    const p = r.proposals.create({
      title: "Sneaky",
      calls: [
        ...newsletters(1),
        { tool: "mail_send_as_write", params: { to: "dana@example.com" }, summary: "Mail Dana" },
      ],
      createdBy: { job: "x" },
    });
    await expect(r.proposals.approve(p.id)).rejects.toMatchObject({ code: "policy_denied" });
    expect(r.ran).toEqual([]);
  });

  it("runs the broker's stored calls: editing the row after approval changes nothing", async () => {
    const r = rig();
    const p = r.proposals.create({
      title: "Mark 2 read",
      calls: newsletters(2),
      createdBy: { job: "mail.digest" },
    });
    const { issued } = await r.proposals.approve(p.id);
    r.db.sqlite
      .prepare("UPDATE action_proposals SET calls = ? WHERE id = ?")
      .run(
        JSON.stringify([
          { tool: "mail_set_flags", params: { ids: ["EVIL"], read: true }, summary: "x" },
        ]),
        p.id,
      );
    await r.answer(issued.approval.id, issued.answerTokens.desktop ?? "");
    await r.proposals.idle();
    expect(r.ran.map((x) => (x.params as { ids: string[] }).ids[0])).toEqual(["m1", "m2"]);
  });

  it("a failing call makes the run partial with per-call results; the rest still run", async () => {
    const r = rig();
    r.failOn("m2");
    const p = r.proposals.create({
      title: "Mark 3 read",
      calls: newsletters(3),
      createdBy: { job: "mail.digest" },
    });
    const { issued } = await r.proposals.approve(p.id);
    await r.answer(issued.approval.id, issued.answerTokens.desktop ?? "");
    await r.proposals.idle();
    const done = r.proposals.get(p.id);
    expect(done.status).toBe("partial");
    expect(done.results?.map((x) => x.status)).toEqual(["ok", "failed", "ok"]);
    expect(done.results?.[1]?.error).toBe("message moved");
  });

  it("undo offers the inverse calls in reverse order for 30 s; it needs its own approval", async () => {
    const r = rig();
    const p = r.proposals.create({
      title: "Mark 2 read",
      calls: newsletters(2),
      createdBy: { job: "mail.digest" },
    });
    const { issued } = await r.proposals.approve(p.id);
    await r.answer(issued.approval.id, issued.answerTokens.desktop ?? "");
    await r.proposals.idle();
    const undo = r.proposals.undo(p.id);
    expect(undo).toMatchObject({ status: "pending", undoOf: p.id, title: "Undo: Mark 2 read" });
    expect(undo.calls.map((c) => c.params)).toEqual([
      { ids: ["m2"], read: false },
      { ids: ["m1"], read: false },
    ]);
    r.clock.advance(31_000);
    expect(() => r.proposals.undo(p.id)).toThrow(expect.objectContaining({ code: "conflict" }));
    const noInverse = r.proposals.create({
      title: "Remind",
      calls: [{ tool: "reminders_create", params: { title: "x" }, summary: "Remind" }],
      createdBy: { job: "x" },
    });
    const a = await r.proposals.approve(noInverse.id);
    await r.answer(a.issued.approval.id, a.issued.answerTokens.desktop ?? "");
    await r.proposals.idle();
    expect(() => r.proposals.undo(noInverse.id)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
  });

  it("taint flows from the proposal to the card and every call; pending proposals expire", async () => {
    const r = rig();
    const p = r.proposals.create({
      title: "Archive receipts",
      calls: newsletters(1),
      createdBy: { job: "mail.digest" },
      taintSources: [{ sourceKind: "email", sender: "shop@example.com" }],
    });
    const { issued } = await r.proposals.approve(p.id);
    expect(issued.approval.taint).toBe(true);
    await r.answer(issued.approval.id, issued.answerTokens.desktop ?? "");
    await r.proposals.idle();
    expect(r.ran[0]?.taint).toBe(true);
    const stale = r.proposals.create({
      title: "Old",
      calls: newsletters(1),
      createdBy: { job: "x" },
      ttlMs: 60_000,
    });
    r.clock.advance(61_000);
    expect(r.proposals.list({ status: ["expired"] }).proposals.map((x) => x.id)).toEqual([
      stale.id,
    ]);
  });

  it("a standing grant for prep notes runs the next Prep: proposal with no card; other notes still ask", async () => {
    const r = rig();
    const prep = (title: string) =>
      r.proposals.create({
        title: "Save prep to Notes",
        calls: [
          {
            tool: "notes_create",
            params: { title, body: "Why: sync" },
            summary: `Add the prep note to Notes: ${title}`,
          },
        ],
        createdBy: { job: "meetings.prep" },
        taint: true,
        taintSources: [{ sourceKind: "calendar" }],
      });
    // First one: the card offers always; the owner picks "Always for prep notes".
    const first = await r.proposals.approve(prep("Prep: Sync 2026-10-27").id);
    expect(first.issued.approval.scopesOffered).toEqual(["once", "always"]);
    r.clock.advance(500);
    await r.broker.answer({
      approvalId: first.issued.approval.id,
      answerToken: first.issued.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "always",
      decidedBy: { deviceId: "dev_mac", surface: "desktop" },
    });
    await r.proposals.idle();
    expect(r.ran.map((x) => x.tool)).toEqual(["notes_create"]);

    // Second one: approved inside approve(), runs, no token to answer.
    const second = await r.proposals.approve(prep("Prep: Planning 2026-10-28").id);
    expect(second.issued.approval).toMatchObject({ status: "approved", scopeGranted: "always" });
    expect(second.issued.answerTokens).toEqual({});
    await r.proposals.idle();
    expect(r.ran.map((x) => (x.params as { title: string }).title)).toEqual([
      "Prep: Sync 2026-10-27",
      "Prep: Planning 2026-10-28",
    ]);
    expect(r.ran[1]?.authority).toMatchObject({ scope: "once" });
    expect(r.ran[1]?.taint).toBe(true);
    expect(r.proposals.get(second.proposal.id).status).toBe("done");

    // A note with any other title still needs its card, and runs nothing until answered.
    const plain = await r.proposals.approve(prep("Groceries").id);
    expect(plain.issued.approval.status).toBe("pending");
    expect(plain.issued.approval.scopesOffered).toEqual(["once"]);
    await r.proposals.idle();
    expect(r.ran).toHaveLength(2);

    // Revoked in Settings → Permissions: the next prep note asks again.
    const [grant] = await r.broker.listGrants();
    await r.broker.revokeGrant(grant?.id ?? "");
    const after = await r.proposals.approve(prep("Prep: Retro 2026-10-29").id);
    expect(after.issued.approval.status).toBe("pending");
    expect(r.ran).toHaveLength(2);
  });

  it("handlers: approve hands the caller its own surface's token only", async () => {
    const r = rig();
    const h = createProposalHandlers(r.proposals);
    const p = r.proposals.create({
      title: "Mark 1 read",
      calls: newsletters(1),
      createdBy: { job: "mail.digest" },
    });
    const desk = await h["proposals.approve"]({ proposalId: p.id }, { surface: "desktop" });
    expect(desk.answerToken).toMatch(/^at_/);
    const q = r.proposals.create({
      title: "Mark 1 read",
      calls: newsletters(1),
      createdBy: { job: "mail.digest" },
    });
    const other = await h["proposals.approve"]({ proposalId: q.id }, { surface: "device:ios" });
    expect(other.answerToken).toBeUndefined();
    expect(
      (await h["proposals.list"]({}, { surface: "desktop" })).proposals.map((x) => x.status),
    ).toEqual(["awaiting_approval", "awaiting_approval"]);
    await expect(
      h["proposals.approve"]({ proposalId: p.id }, { surface: "desktop" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (await h["proposals.dismiss"]({ proposalId: q.id }, { surface: "desktop" })).proposal.status,
    ).toBe("dismissed");
  });
});
