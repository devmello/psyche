import { AgentToolRegistry, paramsHash as callHash } from "@psyche/agent-core";
import {
  appendMessage,
  createThread,
  getPlanFork,
  getPlanForkBranch,
  listAllMessages,
  listPlanForkBranches,
  listStagedActionsForBranch,
  openDb,
  setSetting,
  updatePlanForkBranch,
} from "@psyche/db";
import { type Staging, stagedApplyMatchesSelection } from "@psyche/protocol";
import { toolCallBindingHash } from "@psyche/protocol/binding";
import { SqliteTaskEngine } from "@psyche/tasks";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  CTX,
  DEVICE,
  makeBroker,
  call as policyCall,
} from "../../../packages/permissions/test/helpers.ts";
import { composeForks } from "../src/compose/forks.ts";
import { composeNightShift } from "../src/compose/night-shift.ts";
import { connectorToolLookup } from "../src/compose/proactive.ts";
import { createThreadClear } from "../src/compose/thread-clear.ts";
import type { Call } from "../src/context.ts";
import {
  createPlanForkHandlers,
  PLAN_CONTINUE_PENDING,
  PLAN_TURN_VISIBLE_LINE,
} from "../src/handlers/plan-forks.ts";
import { Idempotency, paramsHash } from "../src/idempotency.ts";

/**
 * Fork a plan F4 end to end over the real stores: create forks a chat into two hidden branches,
 * each branch stages a reminder through the real Night shift stager and files its report, the
 * comparison makes the fork ready, Take promotes one branch's item through one `staged_apply`
 * approval and the Night shift executor, and the parent turn starts tainted. Replays go through the
 * router's own idempotency store.
 */

const START = Date.parse("2026-11-25T10:00:00Z");

async function rig() {
  const clock = new FakeClock(START);
  const db = openDb(":memory:", { now: () => new Date(clock.now()).toISOString() });
  setSetting(db, "nightShift.enabled", true);
  const engine = new SqliteTaskEngine({ db, clock });
  const h = makeBroker({}, clock);
  const registry = new AgentToolRegistry();
  const ran: { tool: string; callId: string }[] = [];
  let made = 0;
  const reg = (name: string, sideEffect: string, run: (p: Record<string, unknown>) => unknown) =>
    registry.register({
      spec: {
        name: `mcp__apple__${name}`,
        description: name,
        inputSchema: { type: "object" },
        sideEffect,
        provenanceOut: "trusted",
      },
      execute: async (callId: string, params: Record<string, unknown>) => {
        if (sideEffect !== "read") ran.push({ tool: name, callId });
        return { output: run(params), provenance: "trusted" };
      },
    } as never);
  reg("reminders_list", "read", () => []);
  reg("reminders_create", "write", () => ({ id: `rem_${++made}` }));
  let pf: ReturnType<typeof createPlanForkHandlers> | undefined;
  const ns = composeNightShift({
    db,
    clock,
    scheduler: {
      list: async () => [],
      get: async () => undefined,
      create: async () => ({}) as never,
      update: async () => ({}) as never,
      remove: async () => {},
    },
    notifier: { notify: async () => ({}) as never },
    tasks: engine as never,
    poke: () => {},
    registry,
    lookup: () => connectorToolLookup(registry),
    keepAwake: { acquire: () => () => undefined },
    readState: async () => ({}) as never,
    timeZone: () => "UTC",
    connectors: async () => [{ id: "apple", type: "apple" }],
    folders: () => [],
    mailCandidates: async () => [],
    followups: { list: () => [] } as never,
    broker: h.broker as never,
    surfaceOf: () => "desktop",
    onForkApplySettled: (s, a, o) => pf?.onApplySettled(s, a, o),
  });
  await ns.start();
  const forks = composeForks({
    db,
    clock,
    tasks: engine as never,
    poke: () => {},
    registry,
    stagerParts: ns.stagerParts,
    onCompare: (id) => pf?.compare(id),
  });
  await forks.start();
  const turns: { threadId: string; content: string; taintSources: unknown[] }[] = [];
  // Whether the parent chat has a run: `startTurn` starts nothing then (it never queues).
  const parent = { busy: false };
  pf = createPlanForkHandlers({
    db,
    clock,
    service: forks.service,
    applier: ns.applier,
    broker: h.broker,
    tasks: engine,
    surfaceOf: () => "desktop",
    startTurn: (i) => {
      if (parent.busy) return false;
      turns.push(i);
      return true;
    },
  });
  const main = createThread(db, { kind: "main", sessionKey: "main" });
  const msg = appendMessage(
    db,
    {
      threadId: main.id,
      role: "user",
      blocks: [{ type: "text", md: "Should we move to Austin?" }] as never,
      provenance: "owner",
      runId: null,
    },
    { expectedWriterRunId: null },
  );
  const desktop = {
    identity: { deviceId: DEVICE.deviceId, role: "client", desktopShell: true },
    conn: { peer: { remoteLoopback: true } },
  } as unknown as Call;
  const idem = new Idempotency(db);
  const run = (method: string, params: unknown, key?: string, call: Call = desktop) => {
    const def = pf?.defs[method];
    if (def === undefined) throw new Error(`no handler ${method}`);
    const go = () => Promise.resolve(def.run(call, params as never));
    if (key === undefined) return go();
    return idem.run({ deviceId: DEVICE.deviceId, method, key }, paramsHash(params), go, true);
  };
  return { db, clock, engine, h, ns, forks, pf, ran, turns, parent, main, msg, run, desktop };
}

type Rig = Awaited<ReturnType<typeof rig>>;

const tick = async (r: Rig) => {
  for (let i = 0; i < 8; i++) {
    await new Promise((res) => setTimeout(res, 0));
    await r.ns.applier?.idle();
  }
};

/** Creates a fork and plays both branches: each stages one reminder and files its report. */
async function readyFork(r: Rig) {
  const params = {
    threadId: r.main.id,
    messageId: r.msg.id,
    branches: [
      { label: "Move to Austin", premise: "Assume we move to Austin by June" },
      { label: "Stay", premise: "Assume we stay" },
    ],
  };
  const created = (await r.run("planForks.create", params, "k-create")) as {
    fork: { id: string };
    branches: { id: string; taskId: string | null }[];
  };
  // A replay with the same key returns the same fork and creates nothing.
  const again = (await r.run("planForks.create", params, "k-create")) as typeof created;
  expect(again.fork.id).toBe(created.fork.id);
  const forkId = created.fork.id;
  for (const b of listPlanForkBranches(r.db, forkId)) {
    const staging: Staging = { kind: "fork", forkId, branchId: b.id };
    const tool = "mcp__apple__reminders_create";
    const p = { title: `Call movers (${b.label})`, listId: "L" };
    await r.forks.sinkFor(staging)?.stage({
      staging,
      runId: `run_${b.id}`,
      taskId: b.taskId,
      toolCallId: `call_${b.id}`,
      tool,
      connector: { id: "apple", action: "reminders.write" },
      sideEffect: "write",
      params: p,
      paramsHash: callHash(p),
      bindingHash: toolCallBindingHash(tool, p, undefined),
      summary: `Remind: ${p.title}`,
      decisionRule: "ask",
      taint: false,
      taintSources: [],
    } as never);
    const [item] = listStagedActionsForBranch(r.db, b.id);
    updatePlanForkBranch(r.db, b.id, {
      taint: true,
      taintSources: [{ sourceKind: "web", origin: "https://example.com/austin" }],
    });
    await r.forks.service.reports.file({
      forkId,
      branchId: b.id,
      runId: `run_${b.id}`,
      toolCallId: "report",
      report: {
        summary: `Working out ${b.label}`,
        steps: [
          { id: "s1", text: "Call the movers", who: "psyche", stagedId: item?.id },
          { id: "s2", text: "Email the landlord about the lease", who: "psyche" },
          { id: "s3", text: "Pack the books", who: "you" },
        ],
        costs: [],
        dates: [],
        people: [],
        tradeoffs: [],
        risks: [],
        openQuestions: [],
      } as never,
    });
    await r.engine.updateStatus(b.taskId as string, "done");
  }
  for (let i = 0; i < 20 && getPlanFork(r.db, forkId)?.status !== "ready"; i++) await tick(r);
  expect(getPlanFork(r.db, forkId)?.status).toBe("ready");
  const [a, b] = listPlanForkBranches(r.db, forkId);
  if (a === undefined || b === undefined) throw new Error("no branches");
  const itemOf = (id: string) => {
    const [x] = listStagedActionsForBranch(r.db, id);
    if (x === undefined) throw new Error("no staged item");
    return x;
  };
  return { forkId, a, b, itemA: itemOf(a.id), itemB: itemOf(b.id) };
}

describe("planForks end to end (F4)", () => {
  it("create, two branches stage, compare, take one item through staged_apply, parent turn tainted", async () => {
    const r = await rig();
    const f = await readyFork(r);
    // Nothing happened in the world while the branches ran.
    expect(r.ran).toEqual([]);
    // The parent chat got its fork card.
    expect(
      listAllMessages(r.db, r.main.id).some((m) => m.blocks.some((x) => x.type === "plan_fork")),
    ).toBe(true);

    const take = {
      forkId: f.forkId,
      branchId: f.a.id,
      items: [{ itemId: f.itemA.id, bindingHash: f.itemA.bindingHash }],
      sends: [],
      continue: true,
    };
    const out = (await r.run("planForks.take", take, "k-take")) as {
      approval?: { id: string; kind: string; details: unknown };
      answerToken?: string;
      refused: unknown[];
    };
    expect(out.refused).toEqual([]);
    expect(out.approval?.kind).toBe("staged_apply");
    // Idempotent replay: the same approval and the same token.
    const replay = (await r.run("planForks.take", take, "k-take")) as typeof out;
    expect(replay.approval?.id).toBe(out.approval?.id);
    expect(replay.answerToken).toBe(out.answerToken);
    // The client's hash check holds for the selection and refuses a swapped item.
    expect(stagedApplyMatchesSelection(out.approval?.details, take)).toBe(true);
    expect(
      stagedApplyMatchesSelection(out.approval?.details, {
        items: [{ itemId: f.itemB.id, bindingHash: f.itemB.bindingHash }],
      }),
    ).toBe(false);

    r.clock.advance(500);
    await r.h.broker.answer({
      approvalId: out.approval?.id ?? "",
      answerToken: out.answerToken ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: DEVICE,
    });
    for (let i = 0; i < 10 && getPlanFork(r.db, f.forkId)?.status !== "taken"; i++) await tick(r);

    expect(r.ran).toEqual([{ tool: "reminders_create", callId: f.itemA.id }]);
    const fork = getPlanFork(r.db, f.forkId);
    expect(fork?.status).toBe("taken");
    expect(fork?.takenBranchId).toBe(f.a.id);
    expect(listStagedActionsForBranch(r.db, f.a.id)[0]?.status).toBe("applied");
    // The other branch's item can never be applied now.
    expect(listStagedActionsForBranch(r.db, f.b.id)[0]?.status).toBe("dismissed");
    expect(
      listAllMessages(r.db, r.main.id).some((m) => m.blocks.some((x) => x.type === "plan_taken")),
    ).toBe(true);
    // One parent turn: the remaining Psyche step (not the applied one, not the owner's), fenced,
    // carrying the branch's taint so grants and Auto don't apply and the write asks.
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0];
    expect(turn?.taintSources).toEqual([
      { sourceKind: "web", origin: "https://example.com/austin" },
    ]);
    expect(turn?.content).toContain("Email the landlord about the lease");
    expect(turn?.content).not.toContain("Call the movers");
    expect(turn?.content).not.toContain("Pack the books");
    expect(turn?.content).toMatch(/```json\n/);

    // That turn's first unstaged write asks, in Auto mode too: the broker sees the turn's taint,
    // a card is created and nothing runs until the owner taps it.
    const write = policyCall("mcp__apple__reminders_create", "write", undefined, {
      params: { title: "Email the landlord", listId: "L" },
    });
    const parentCtx = {
      ...CTX,
      threadId: r.main.id,
      runId: "run_parent",
      taskId: undefined,
      permissionMode: "auto" as const,
      taint: true,
      taintSources: turn?.taintSources as never,
    };
    const d = await r.h.broker.decide(write, parentCtx);
    expect(d.decision).toBe("ask");
    const ranBefore = r.ran.length;
    const card = await r.h.broker.requestApproval({
      kind: d.approvalKind ?? "tool_call",
      summary: "Remind: Email the landlord",
      details: {},
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: "run_parent", taskId: null, threadId: r.main.id },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: true,
    } as never);
    const pending = await r.h.broker.list({ status: "pending" });
    expect(pending.map((a) => a.id)).toContain(card.approval.id);
    expect(r.ran).toHaveLength(ranBefore);
  });

  it("a busy parent chat leaves Continue on the taken plan; tapping it starts the tainted turn once", async () => {
    const r = await rig();
    const f = await readyFork(r);
    r.parent.busy = true;
    const out = (await r.run("planForks.take", {
      forkId: f.forkId,
      branchId: f.a.id,
      items: [{ itemId: f.itemA.id, bindingHash: f.itemA.bindingHash }],
      sends: [],
      continue: true,
    })) as { approval?: { id: string }; answerToken?: string };
    r.clock.advance(500);
    await r.h.broker.answer({
      approvalId: out.approval?.id ?? "",
      answerToken: out.answerToken ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: DEVICE,
    });
    for (let i = 0; i < 10 && getPlanFork(r.db, f.forkId)?.status !== "taken"; i++) await tick(r);
    // Nothing was queued (a queued follow-up would drop the taint); the plan says Continue.
    expect(getPlanFork(r.db, f.forkId)).toMatchObject({
      status: "taken",
      error: PLAN_CONTINUE_PENDING,
    });
    expect(r.turns).toEqual([]);
    const cont = { forkId: f.forkId, branchId: f.a.id, items: [], sends: [], continue: true };
    // Still busy: refused, and Continue stays.
    await expect(r.run("planForks.take", cont)).rejects.toThrow(/busy/);
    expect(getPlanFork(r.db, f.forkId)?.error).toBe(PLAN_CONTINUE_PENDING);
    r.parent.busy = false;
    // A double tap starts one turn.
    await Promise.all([r.run("planForks.take", cont), r.run("planForks.take", cont)]);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.taintSources).toEqual([
      { sourceKind: "web", origin: "https://example.com/austin" },
    ]);
    expect(r.turns[0]?.content).toContain("Email the landlord about the lease");
    expect(getPlanFork(r.db, f.forkId)?.error).toBeNull();
    // Another branch, or a plan with nothing pending, is not a Continue.
    await expect(r.run("planForks.take", { ...cont, branchId: f.b.id })).rejects.toThrow(/taken/);
    expect(r.turns).toHaveLength(1);
  });

  it("a declined approval leaves the fork ready and applies nothing", async () => {
    const r = await rig();
    const f = await readyFork(r);
    const out = (await r.run("planForks.take", {
      forkId: f.forkId,
      branchId: f.a.id,
      items: [{ itemId: f.itemA.id, bindingHash: f.itemA.bindingHash }],
      sends: [],
      continue: true,
    })) as { approval?: { id: string }; answerToken?: string };
    r.clock.advance(500);
    await r.h.broker.answer({
      approvalId: out.approval?.id ?? "",
      answerToken: out.answerToken ?? "",
      decision: "deny",
      decidedBy: DEVICE,
    });
    await tick(r);
    expect(r.ran).toEqual([]);
    expect(getPlanFork(r.db, f.forkId)?.status).toBe("ready");
    expect(getPlanFork(r.db, f.forkId)?.takeApprovalId).toBeNull();
    expect(listStagedActionsForBranch(r.db, f.a.id)[0]?.status).toBe("ready");
    expect(r.turns).toEqual([]);
  });

  it("refuses an item whose hash differs from the selection, and another branch's item", async () => {
    const r = await rig();
    const f = await readyFork(r);
    const out = (await r.run("planForks.take", {
      forkId: f.forkId,
      branchId: f.a.id,
      items: [
        { itemId: f.itemA.id, bindingHash: "sha256:not-what-was-shown" },
        { itemId: f.itemB.id, bindingHash: f.itemB.bindingHash },
      ],
      sends: [],
      continue: false,
    })) as { approval?: unknown; refused: { itemId: string; reason: string }[] };
    expect(out.approval).toBeUndefined();
    expect(out.refused.map((x) => [x.itemId, x.reason])).toEqual([
      [f.itemA.id, "the item changed since it was shown"],
      [f.itemB.id, "not in this review"],
    ]);
    expect(getPlanFork(r.db, f.forkId)?.status).toBe("ready");
  });

  it("clear chat cancels a running fork and removes its hidden threads", async () => {
    const r = await rig();
    const created = (await r.run("planForks.create", {
      threadId: r.main.id,
      messageId: r.msg.id,
      branches: [
        { label: "A", premise: "Assume A" },
        { label: "B", premise: "Assume B" },
      ],
    })) as { fork: { id: string }; branches: { threadId: string }[] };
    expect(getPlanFork(r.db, created.fork.id)?.status).toBe("running");
    // Through the real `threads.clear` handler, wired to the fork's thread-ending hook as the
    // composed Gateway wires it.
    const clear = createThreadClear({
      db: r.db,
      audit: r.h.audit,
      broker: r.h.broker,
      isRunning: () => false,
    })["threads.clear"];
    const ctx = {
      db: r.db,
      threadEnding: new Set([(id: string) => r.pf.onThreadEnding(id)]),
      threadEnded: new Set(),
      bus: { bumpStateVersion: () => {}, publish: () => {} },
      memory: null,
    };
    expect(
      await clear?.run({ ...r.desktop, ctx } as never, { threadId: r.main.id } as never),
    ).toEqual({ ok: true });
    await tick(r);
    expect(listAllMessages(r.db, r.main.id)).toEqual([]);
    expect(getPlanFork(r.db, created.fork.id)).toBeNull();
    const tasks = await r.engine.list({});
    expect(tasks.every((t) => t.status === "cancelled")).toBe(true);
    for (const b of created.branches) {
      expect(
        r.db.sqlite.prepare("SELECT 1 FROM threads WHERE id = ?").get(b.threadId),
      ).toBeUndefined();
    }
  });
});

const phone = {
  identity: { deviceId: "dev_phone", role: "client" },
  conn: { peer: { remoteLoopback: false } },
} as unknown as Call;

/** Files a branch's report (no staged items) and ends its task. */
async function report(r: Rig, forkId: string, branchId: string, summary: string, steps: string[]) {
  const b = listPlanForkBranches(r.db, forkId).find((x) => x.id === branchId);
  await r.forks.service.reports.file({
    forkId,
    branchId,
    runId: `run_${branchId}`,
    toolCallId: "report",
    report: {
      summary,
      steps: steps.map((text, i) => ({ id: `s${i}`, text, who: "psyche" })),
      costs: [],
      dates: [],
      people: [],
      tradeoffs: [],
      risks: [],
      openQuestions: [],
    } as never,
  });
  await r.engine.updateStatus(b?.taskId as string, "done");
}

const read = (r: Rig, forkId: string, branchId: string, tool: string) =>
  r.forks.service.readsFor({ kind: "fork", forkId, branchId })?.observe({
    callId: `c_${tool}`,
    tool,
    sideEffect: "read",
    args: {},
    output: { items: [] },
    ok: true,
    provenance: "trusted",
  });

describe("planForks R1 fixes", () => {
  it("an owner-only read in a failed run keeps the branch restricted after a retry (finding 2)", async () => {
    const r = await rig();
    const created = (await r.run("planForks.create", {
      threadId: r.main.id,
      messageId: r.msg.id,
      branches: [
        { label: "Move", premise: "Assume we move" },
        { label: "Stay", premise: "Assume we stay" },
      ],
    })) as { fork: { id: string } };
    const forkId = created.fork.id;
    const [a, b] = listPlanForkBranches(r.db, forkId);
    if (a === undefined || b === undefined) throw new Error("no branches");
    // Run 1 reads Messages, then fails.
    read(r, forkId, a.id, "mcp__apple__messages_search");
    expect(getPlanForkBranch(r.db, a.id)?.readOwnerOnly).toBe(true);
    await r.engine.updateStatus(a.taskId as string, "failed");
    await tick(r);
    expect(getPlanForkBranch(r.db, a.id)?.status).toBe("failed");
    await r.run("planForks.retryBranch", { forkId, branchId: a.id });
    // Run 2 reads nothing owner-only and reports.
    await report(r, forkId, a.id, "Moving costs about $4,000", ["Book movers"]);
    // The control: a branch that read only calendar, mail and web is shown.
    read(r, forkId, b.id, "mcp__apple__calendar_list_events");
    read(r, forkId, b.id, "mcp__apple__mail_search");
    await report(r, forkId, b.id, "Staying keeps rent flat", ["Renew the lease"]);
    for (let i = 0; i < 20 && getPlanFork(r.db, forkId)?.status !== "ready"; i++) await tick(r);
    expect(getPlanForkBranch(r.db, a.id)?.readOwnerOnly).toBe(true);
    expect(getPlanForkBranch(r.db, b.id)?.readOwnerOnly).toBe(false);
    type View = { branches: { id: string; report: { summary: string } | null }[] };
    const onPhone = (await r.run("planForks.get", { forkId }, undefined, phone)) as View;
    const summaryOf = (v: View, id: string) => v.branches.find((x) => x.id === id)?.report?.summary;
    expect(summaryOf(onPhone, a.id)).toBe("");
    expect(summaryOf(onPhone, b.id)).toBe("Staying keeps rent flat");
    const onMac = (await r.run("planForks.get", { forkId })) as View;
    expect(summaryOf(onMac, a.id)).toBe("Moving costs about $4,000");
  });

  it("the parent turn of an owner-only branch puts the plan in the agent's preamble only (finding 4)", async () => {
    const r = await rig();
    const f = await readyFork(r);
    updatePlanForkBranch(r.db, f.a.id, { readOwnerOnly: true });
    await r.run("planForks.take", {
      forkId: f.forkId,
      branchId: f.a.id,
      items: [],
      sends: [],
      continue: true,
    });
    expect(r.turns).toHaveLength(1);
    const turn = r.turns[0] as (typeof r.turns)[number] & { preamble?: string };
    expect(turn.content).not.toContain("Email the landlord");
    expect(turn.content).toContain(PLAN_TURN_VISIBLE_LINE);
    expect(turn.preamble).toContain("Email the landlord about the lease");
    expect(turn.taintSources).toEqual([
      { sourceKind: "web", origin: "https://example.com/austin" },
    ]);
  });

  it("the parent turn leaves out steps whose items were not ticked (finding 6)", async () => {
    const r = await rig();
    const f = await readyFork(r);
    // Take with nothing ticked: the movers step (staged) is the owner's choice not to do.
    await r.run("planForks.take", {
      forkId: f.forkId,
      branchId: f.a.id,
      items: [],
      sends: [],
      continue: true,
    });
    expect(r.turns[0]?.content).toContain("Email the landlord about the lease");
    expect(r.turns[0]?.content).not.toContain("Call the movers");
    expect(r.ran).toEqual([]);
  });

  it("two takes of the same fork at once: the second is a conflict and one branch applies (finding 5)", async () => {
    const r = await rig();
    const f = await readyFork(r);
    const takeOf = (branchId: string, item: { id: string; bindingHash: string }) =>
      r.run("planForks.take", {
        forkId: f.forkId,
        branchId,
        items: [{ itemId: item.id, bindingHash: item.bindingHash }],
        sends: [],
        continue: false,
      }) as Promise<{ approval?: { id: string }; answerToken?: string }>;
    const [one, two] = await Promise.allSettled([takeOf(f.a.id, f.itemA), takeOf(f.b.id, f.itemB)]);
    expect(one.status).toBe("fulfilled");
    expect(two.status).toBe("rejected");
    expect((two as PromiseRejectedResult).reason).toMatchObject({ code: "conflict" });
    const out = (one as PromiseFulfilledResult<{ approval?: { id: string }; answerToken?: string }>)
      .value;
    expect((await r.h.broker.list({ status: "pending" })).map((a) => a.id)).toEqual([
      out.approval?.id,
    ]);
    r.clock.advance(500);
    await r.h.broker.answer({
      approvalId: out.approval?.id ?? "",
      answerToken: out.answerToken ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: DEVICE,
    });
    for (let i = 0; i < 10 && getPlanFork(r.db, f.forkId)?.status !== "taken"; i++) await tick(r);
    expect(r.ran).toEqual([{ tool: "reminders_create", callId: f.itemA.id }]);
    expect(listStagedActionsForBranch(r.db, f.b.id)[0]?.status).toBe("dismissed");
    // A take after the plan is taken is refused as before.
    await expect(takeOf(f.b.id, f.itemB)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("planForks.staged", () => {
  type Items = { id: string; summary: string; withheld?: string; params: unknown }[];
  const fromMessages = (r: Rig, itemId: string) =>
    r.db.sqlite
      .prepare("UPDATE staged_actions SET taint_sources = ? WHERE id = ?")
      .run(JSON.stringify([{ sourceKind: "message", origin: "imessage" }]), itemId);

  it("gives the owner's desktop the full items of the branch", async () => {
    const r = await rig();
    const f = await readyFork(r);
    fromMessages(r, f.itemA.id);
    const out = (await r.run("planForks.staged", { forkId: f.forkId, branchId: f.a.id })) as {
      items: Items;
    };
    expect(out.items.map((i) => i.id)).toEqual([f.itemA.id]);
    expect(out.items[0]?.summary).toBe(f.itemA.summary);
    expect(out.items[0]?.params).not.toBeNull();
    expect(out.items[0]?.withheld).toBeUndefined();
  });

  it("maps the items through forRemote for a phone, and leaves items from other sources whole", async () => {
    const r = await rig();
    const f = await readyFork(r);
    fromMessages(r, f.itemA.id);
    const phoneOut = (await r.run(
      "planForks.staged",
      { forkId: f.forkId, branchId: f.a.id },
      undefined,
      phone,
    )) as { items: Items };
    expect(phoneOut.items[0]?.withheld).toBe("messages");
    expect(phoneOut.items[0]?.params).toBeNull();
    expect(phoneOut.items[0]?.summary).not.toBe(f.itemA.summary);
    // The control: a branch whose item did not come from Messages is the same on the phone.
    const other = (await r.run(
      "planForks.staged",
      { forkId: f.forkId, branchId: f.b.id },
      undefined,
      phone,
    )) as { items: Items };
    expect(other.items[0]?.withheld).toBeUndefined();
    expect(other.items[0]?.summary).toBe(f.itemB.summary);
  });

  it("refuses an unknown fork, an unknown branch and a branch of another fork", async () => {
    const r = await rig();
    const f = await readyFork(r);
    await expect(
      r.run("planForks.staged", { forkId: "nope", branchId: f.a.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      r.run("planForks.staged", { forkId: f.forkId, branchId: "nope" }),
    ).rejects.toMatchObject({ code: "not_found" });
    const second = (await r.run("planForks.create", {
      threadId: r.main.id,
      messageId: r.msg.id,
      branches: [
        { label: "Rent", premise: "Assume we rent" },
        { label: "Buy", premise: "Assume we buy" },
      ],
    })) as { fork: { id: string } };
    await expect(
      r.run("planForks.staged", { forkId: second.fork.id, branchId: f.a.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    // The control: the right pair answers.
    await expect(
      r.run("planForks.staged", { forkId: f.forkId, branchId: f.a.id }),
    ).resolves.toBeDefined();
  });
});
