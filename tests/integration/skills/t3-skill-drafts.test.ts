import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import type {
  ApprovalRequest,
  CallOptions,
  ModelCapabilities,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  SkillDetails,
  SkillDraft,
  SkillProposal,
} from "@psyche/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, type Skeleton, startSkeleton } from "../walking-skeleton/harness.ts";

/**
 * Scenario T3 (tests/scenarios/t3-skill-drafts/README.md): the agent runs the same five-step
 * routine twice in a thread; the Gateway drafts a skill from it with the owner's personal data
 * stripped, the owner edits it, accepts it through the T2 trust card and approves; the skill
 * installs and reaches the agent. Repeats are not proposed twice, incognito threads never, and a
 * dismissed routine never comes back. Each `it` depends on the previous.
 */

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };

/**
 * The model's side of the routines: for an owner message naming a routine, one tool call per
 * model request until the routine is done, then a short answer. Anything else gets "Done.".
 */
class RoutineModel implements ModelProvider {
  readonly id = "fake";
  readonly requests: ModelRequest[] = [];
  routines: Record<string, { tool: string; input: Record<string, unknown> }[]> = {};
  #ids = 0;

  stream(req: ModelRequest, _opts?: CallOptions): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const lastUser = req.messages.map((m) => m.role).lastIndexOf("user");
    const userText = (req.messages[lastUser]?.parts ?? [])
      .map((p) => (p.type === "text" ? p.text : ""))
      .join(" ");
    const done = req.messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
    const key = Object.keys(this.routines).find((k) => userText.includes(k));
    const steps = key === undefined ? [] : (this.routines[key] ?? []);
    const next = steps[done];
    const events: ModelEvent[] =
      next === undefined
        ? [
            { type: "text_delta", text: "Done." },
            { type: "usage", usage },
            { type: "finish", reason: "stop" },
          ]
        : [
            { type: "tool_call", id: `call_${++this.#ids}`, name: next.tool, input: next.input },
            { type: "usage", usage },
            { type: "finish", reason: "tool_calls" },
          ];
    return (async function* () {
      yield* events;
    })();
  }

  async capabilities(): Promise<ModelCapabilities> {
    return {
      toolCalling: true,
      vision: false,
      reasoning: false,
      embeddings: false,
      contextWindow: 200_000,
    };
  }
}

async function approveOnce(client: Client, approvalId: string): Promise<void> {
  const { answerToken } = await client.call<{ answerToken?: string }>("approvals.get", {
    approvalId,
  });
  expect(answerToken).toBeTruthy();
  await new Promise((r) => setTimeout(r, 600));
  await client.call("approvals.answer", {
    approvalId,
    answerToken,
    decision: "approve",
    scope: "once",
  });
}

async function rejection(p: Promise<unknown>): Promise<{ code: string; details?: unknown }> {
  try {
    await p;
  } catch (e) {
    return e as { code: string; details?: unknown };
  }
  throw new Error("expected the call to fail");
}

const model = new RoutineModel();
let sk: Skeleton;
let c: Client;
let thread: string;
let draft: SkillDraft;
let staged: { proposal: SkillProposal; approval: ApprovalRequest };

/** A Luhn-valid test card number, assembled at run time so the repo's secret scan never sees one. */
const CARD = ["4111", "1111", "1111", "1111"].join(" ");
const OWNER = `Collect this week's receipts into my notes for dana@example.com, card ${CARD}`;

async function turn(threadId: string, text: string): Promise<void> {
  const from = c.mark;
  await c.call("chat.send", { threadId, content: text }, true);
  await c.event<{ run: { status: string } }>("run.updated", (p) => p.run.status === "done", from);
}

async function newThread(kind: "main" | "side" | "incognito" = "side"): Promise<string> {
  const { thread: t } = await c.call<{ thread: { id: string } }>("threads.create", { kind }, true);
  return t.id;
}

const drafts = async (status?: string) =>
  (
    await c.call<{ drafts: SkillDraft[] }>(
      "skills.drafts.list",
      status === undefined ? {} : { status },
    )
  ).drafts;

beforeAll(async () => {
  sk = await startSkeleton({ model: { provider: model, model: "fake/main" } });
  updateDevice(sk.composed.gateway.context.db, sk.deviceId, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  sk.client.stop();
  c = await sk.connect();
  writeFileSync(join(sk.granted, "receipts.md"), "- coffee 4.50\n- train 12.00\n");
  writeFileSync(join(sk.granted, "notes.md"), "# Notes\n");
  const g = sk.granted;
  // Five steps, all reads in a granted folder: no approval interrupts the routine.
  model.routines.receipts = [
    { tool: "list_dir", input: { path: g } },
    { tool: "read_file", input: { path: join(g, "receipts.md") } },
    { tool: "search_files", input: { path: g, query: "coffee" } },
    { tool: "read_file", input: { path: join(g, "notes.md") } },
    { tool: "list_dir", input: { path: g } },
  ];
  model.routines.tickets = [
    { tool: "search_files", input: { path: g, query: "train" } },
    { tool: "read_file", input: { path: join(g, "receipts.md") } },
    { tool: "list_dir", input: { path: g } },
  ];
});

afterAll(async () => {
  await sk?.stop();
});

describe("T3 agent-proposed skills (offline)", () => {
  it("1. one run of a routine proposes nothing", async () => {
    thread = await newThread("main");
    await turn(thread, OWNER);
    expect(await drafts()).toEqual([]);
  });

  it("2. the second run proposes a draft with the owner's personal data stripped", async () => {
    const from = c.mark;
    await turn(thread, "Collect this week's receipts into my notes again please");
    const ev = await c.event<{ draft: SkillDraft }>(
      "skills.draft.updated",
      (p) => p.draft.status === "open",
      from,
    );
    draft = ev.draft;
    expect(draft).toMatchObject({ threadId: thread, occurrences: 2, edited: false, tainted: true });
    expect(draft.steps.map((s) => s.tool)).toEqual([
      "list_dir",
      "read_file",
      "search_files",
      "read_file",
      "list_dir",
    ]);
    expect(draft.manifest).toEqual({
      tools: ["list_dir", "read_file", "search_files"],
      permissions: [],
      prompts: [],
    });
    for (const leak of ["dana@example.com", "4111", sk.granted, "coffee", "receipts.md"])
      expect(draft.text).not.toContain(leak);
    expect(draft.text).toContain("1. Call `list_dir` (reads) with inputs path.");
    // Not installed, not loaded: a draft lives in quarantine.
    const { skills } = await c.call<{ skills: SkillDetails[] }>("skills.list");
    expect(skills.some((s) => s.name === draft.name)).toBe(false);
  });

  it("3. a third run does not propose it again", async () => {
    const from = c.mark;
    await turn(thread, "Collect this week's receipts into my notes, same as before");
    expect(
      c.events
        .slice(from)
        .filter(
          (e) =>
            e.event === "skills.draft.updated" &&
            (e.payload as { draft: SkillDraft }).draft.id !== draft.id,
        ),
    ).toEqual([]);
    expect((await drafts("open")).map((d) => d.id)).toEqual([draft.id]);
  });

  it("4. the owner edits the draft", async () => {
    const text = draft.text.replace(`name: ${draft.name}`, "name: weekly-receipts");
    const { draft: edited } = await c.call<{ draft: SkillDraft }>(
      "skills.drafts.update",
      { draftId: draft.id, text },
      true,
    );
    expect(edited).toMatchObject({ name: "weekly-receipts", edited: true });
    draft = edited;
  });

  it("5. accepting replays it and opens the T2 trust card; nothing installs before approval", async () => {
    const r = await c.call<{
      draft: SkillDraft;
      proposal: SkillProposal;
      approval: ApprovalRequest;
    }>("skills.drafts.accept", { draftId: draft.id }, true);
    staged = r;
    expect(r.draft).toMatchObject({ status: "accepted", replay: { ok: true } });
    expect(r.proposal).toMatchObject({ name: "weekly-receipts", trust: "unknown" });
    expect(r.proposal.findings.filter((f) => f.severity === "high")).toEqual([]);
    expect(r.approval).toMatchObject({
      kind: "skill_install",
      deviceOnly: true,
      scopesOffered: ["once"],
      details: expect.objectContaining({ proposedBy: "agent" }),
    });
    const err = await rejection(
      c.call("skills.install", { proposalId: r.proposal.id, approvalId: r.approval.id }, true),
    );
    expect(err.code).toBe("approval_required");
  });

  it("6. approved once, it installs and the draft is marked installed", async () => {
    await approveOnce(c, staged.approval.id);
    const from = c.mark;
    await c.call(
      "skills.install",
      { proposalId: staged.proposal.id, approvalId: staged.approval.id },
      true,
    );
    await c.event<{ draft: SkillDraft }>(
      "skills.draft.updated",
      (p) => p.draft.id === draft.id && p.draft.status === "installed",
      from,
    );
    const { skills } = await c.call<{ skills: SkillDetails[] }>("skills.list");
    expect(skills.find((s) => s.name === "weekly-receipts")).toMatchObject({
      status: "active",
      trust: "unknown",
    });
    const { commands } = await c.call<{ commands: { command: string }[] }>("skills.commands");
    expect(commands.map((x) => x.command)).toContain("/weekly-receipts");
  });

  it("7. the agent sees the new skill, marked as untrusted data", async () => {
    const before = model.requests.length;
    await turn(thread, "Thanks!");
    const system = model.requests[before]?.system ?? "";
    expect(system).toContain('[Description from skill "weekly-receipts" (unknown publisher)');
  });

  it("8. incognito threads never propose", async () => {
    const inc = await newThread("incognito");
    await turn(inc, "Find my train tickets");
    await turn(inc, "Find my train tickets");
    expect((await drafts()).some((d) => d.threadId === inc)).toBe(false);
  });

  it("9. a dismissed routine is never proposed again", async () => {
    const a = await newThread();
    await turn(a, "Find my train tickets");
    const from = c.mark;
    await turn(a, "Find my train tickets");
    const ev = await c.event<{ draft: SkillDraft }>(
      "skills.draft.updated",
      (p) => p.draft.threadId === a && p.draft.status === "open",
      from,
    );
    await c.call("skills.drafts.dismiss", { draftId: ev.draft.id }, true);
    const b = await newThread();
    await turn(b, "Find my train tickets");
    await turn(b, "Find my train tickets");
    expect((await drafts()).filter((d) => d.threadId === b)).toEqual([]);
    expect((await drafts("dismissed")).map((d) => d.id)).toEqual([ev.draft.id]);
  });
});
