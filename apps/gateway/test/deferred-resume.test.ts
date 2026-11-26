import { openDb } from "@psyche/db";
import { PsycheNotifier } from "@psyche/notifications";
import {
  createPermissionBroker,
  type PolicyCall,
  SqlitePermissionStore,
} from "@psyche/permissions";
import { createDbSessionResolver, type RunLauncher, SqliteScheduler } from "@psyche/scheduler";
import { FakeClock, sha256 } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  DeferredResume,
  RESUME_MISSED_BODY_KEY,
  RESUME_MISSED_TITLE_KEY,
} from "../src/compose/deferred-resume.ts";

const T0 = Date.parse("2026-11-18T10:00:00Z");
const NOTES = "/Users/owner/Notes/weekly.md";

function writeCall(path: string): PolicyCall {
  const params = { path, content: "notes" };
  return {
    tool: "write_file",
    sideEffect: "write",
    target: { kind: "path", value: path },
    targetKind: "path",
    params,
    paramsHash: sha256(JSON.stringify(params)),
  };
}

function connectorCall(path: string): PolicyCall {
  const params = { path };
  return {
    tool: "conn.action",
    sideEffect: "write",
    params,
    paramsHash: sha256(JSON.stringify(params)),
  };
}

/**
 * The real broker, scheduler and DeferredResume, with a launcher that does what the agent loop
 * does for an unattended run (the loop's own part is tested in agent-core features.test.ts):
 * decide → an approved set-aside card for this exact call? (`claim` + `verifyBinding`, then do
 * it and record its receipt) → otherwise set the action aside and finish without it.
 */
function setup(
  plans: string[],
  opts: {
    failWrites?: boolean;
    noReceipt?: boolean;
    standing?: boolean;
    /** Another `gmail.send` in the same run succeeded first (no grant id on its receipt). */
    unrelatedOk?: boolean;
    /** The provider did not confirm the grant's call. */
    uncertain?: boolean;
    /**
     * Holds `approval.decided` back until `deliverDecided()`: the broker stores the grant, then
     * finishes the answer before it announces the decision.
     */
    holdDecided?: boolean;
  } = {},
) {
  const clock = new FakeClock(T0);
  const db = openDb(":memory:");
  const notifier = new PsycheNotifier({ clock });
  let resume!: DeferredResume;
  const brokerFor = (r: () => DeferredResume) =>
    createPermissionBroker({
      armDelayMs: 0,
      clock,
      approvers: {
        device: async () => ({ scopes: ["operator.read", "operator.approvals"] }),
      },
      // On the Gateway database, so a second broker on it is a restart.
      store: new SqlitePermissionStore(db.sqlite),
      policy: { folders: [{ path: "/Users/owner", mode: "rw" }] },
      canResume: (a) => r().canResume(a),
      onSetAsideRevoked: (a, how) => r().revokedAtRestart(a, how),
    });
  const broker = brokerFor(() => resume);
  const written: string[] = [];
  const gates: (() => void)[] = [];
  let hold = false;
  let n = 0;
  const launcher: RunLauncher = {
    async launch(request) {
      n += 1;
      const i = n;
      const taskId = `task_${i}`;
      const held = hold
        ? new Promise<void>((r) => {
            gates.push(r);
          })
        : Promise.resolve();
      const result = (async () => {
        const path = plans[i - 1] ?? NOTES;
        // `standing`: a connector action in balanced mode, whose card offers `always`.
        const call = opts.standing === true ? connectorCall(path) : writeCall(path);
        const ctx = {
          threadId: request.threadId,
          runId: `run_${i}`,
          taskId,
          permissionMode: opts.standing === true ? ("balanced" as const) : ("manual" as const),
          taint: false,
          unattended: true,
        };
        const d = await broker.decide(call, ctx);
        if (d.decision === "allow" && d.grantId !== undefined) {
          // A standing grant let the call through. As ConnectorRegistry records it: the tool's
          // action as kind, the call's task, no approval, and the grant's id and the call's
          // binding in its payload.
          if (opts.unrelatedOk === true) {
            await broker.recordReceipt({
              kind: "gmail.send",
              outcome: "ok",
              summary: "Sent another email",
              taskId,
              approvalId: null,
              payload: { rule: "mode:balanced/write" },
            });
          }
          if (opts.failWrites !== true) written.push(path);
          if (opts.noReceipt !== true) {
            await broker.recordReceipt({
              kind: "gmail.send",
              outcome:
                opts.uncertain === true ? "uncertain" : opts.failWrites === true ? "failed" : "ok",
              summary: `Sent ${path}`,
              taskId,
              approvalId: null,
              payload: {
                rule: `grant:${d.grantId}`,
                via: "grant",
                grantId: d.grantId,
                bindingHash: d.bindingHash ?? "",
              },
            });
          }
        }
        if (d.decision === "ask" && d.bindingHash !== undefined && d.approvalKind !== undefined) {
          const id = await resume.claim({
            taskId,
            kind: d.approvalKind,
            bindingHash: d.bindingHash,
            taint: false,
          });
          const v = id === undefined ? undefined : await broker.verifyBinding(id, d.bindingHash);
          if (v?.ok === true) {
            // The action runs; with `failWrites` it fails (a `failed` receipt).
            if (opts.failWrites !== true) written.push(path);
            await broker.recordReceipt({
              kind: "file_write",
              outcome: opts.failWrites === true ? "failed" : "ok",
              summary: `Wrote ${path}`,
              taskId,
              approvalId: id ?? null,
            });
          } else {
            await broker.requestApproval({
              kind: d.approvalKind,
              summary: `Write ${path}`,
              details: {},
              bindingHash: d.bindingHash,
              grantKey: d.grantKey ?? "k",
              requestedBy: { runId: ctx.runId, taskId, threadId: ctx.threadId },
              sideEffect: "write",
              target: call.target,
              surfaces: ["desktop"],
              taint: false,
              setAside: true,
            });
          }
        }
        await held;
        return { status: "done" as const, summary: "ok", taskId };
      })();
      return { taskId, result };
    },
  };
  const scheduler = new SqliteScheduler({
    db,
    clock,
    timers: { setTimeout: () => undefined, clearTimeout: () => {} },
    launcher,
    sessions: createDbSessionResolver(db),
    notifier,
  });
  resume = new DeferredResume({
    scheduler,
    notifier,
    clock,
    settle: (id) => broker.settleSetAside(id),
  });
  const decided: Parameters<DeferredResume["onBrokerEvent"]>[0][] = [];
  broker.subscribe((e) => {
    if (opts.holdDecided === true && e.type === "approval.decided") decided.push(e);
    else resume.onBrokerEvent(e);
  });
  scheduler.subscribe((e) => {
    if (e.event === "automation.run.finished") resume.onRunFinished(e.payload.run);
  });
  const pendingCards = () => broker.list({ status: "pending" });
  const approve = async (id: string, token: string, scope: "once" | "always" = "once") =>
    broker.answer({
      approvalId: id,
      answerToken: token,
      decision: "approve",
      scope,
      decidedBy: { deviceId: "dev_mac", surface: "desktop" },
    });
  /** Let the scheduler, the resume queue and the runs it starts settle. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await scheduler.idle();
      await resume.idle();
    }
  };
  const issued = async () => {
    const [card] = await pendingCards();
    if (card === undefined) throw new Error("no pending card");
    // The test reads the answer token the way a paired device receives it.
    return card;
  };
  /** A Gateway restart: a new broker and DeferredResume on the same database, then reissue. */
  const restart = async () => {
    let next!: DeferredResume;
    const b = brokerFor(() => next);
    next = new DeferredResume({ scheduler, notifier, clock, settle: (id) => b.settleSetAside(id) });
    await b.reissue();
    await next.idle();
    return { broker: b, resume: next };
  };
  return {
    broker,
    clock,
    restart,
    scheduler,
    resume,
    notifier,
    written,
    pendingCards,
    approve,
    settle,
    issued,
    deliverDecided: () => {
      for (const e of decided.splice(0)) resume.onBrokerEvent(e);
    },
    launches: () => n,
    holdRuns: (on: boolean) => {
      hold = on;
    },
    release: () => {
      for (const g of gates.splice(0)) g();
    },
  };
}

/** Captures the answer token of every card as the broker issues it. */
function tokens(h: ReturnType<typeof setup>) {
  const map = new Map<string, string>();
  const original = h.broker.requestApproval.bind(h.broker);
  h.broker.requestApproval = async (input) => {
    const out = await original(input);
    map.set(out.approval.id, out.answerTokens.desktop ?? "");
    return out;
  };
  return map;
}

const automation = {
  kind: "cron" as const,
  title: "Weekly notes",
  schedule: "0 17 * * 5",
  prompt: "Write the weekly notes.",
};

describe("Approve on a set-aside card resumes the automation (DeferredResume)", () => {
  it("approve → a resume run reaches the identical call → it is done exactly once", async () => {
    const h = setup([NOTES, NOTES, NOTES]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    expect(h.written).toEqual([]);
    const card = await h.issued();
    expect(card.setAside).toBe(true);
    expect(card.riskClass).toBe("routine");

    expect((await h.approve(card.id, tok.get(card.id) ?? "")).status).toBe("approved");
    await h.settle();
    // The resume run re-planned, reached the same write and used the approval once.
    expect(h.written).toEqual([NOTES]);
    expect(await h.pendingCards()).toHaveLength(0);
    expect(h.resume.pending()).toEqual([]);
    expect(await h.notifier.list()).toHaveLength(0);
    expect((await h.broker.listReceipts({ approvalId: card.id })).length).toBe(1);

    // A later run of the automation does not get to reuse it: it sets the action aside again.
    await h.scheduler.trigger(a.id);
    await h.settle();
    expect(h.written).toEqual([NOTES]);
    expect(await h.pendingCards()).toHaveLength(1);
  });

  it("a resume run that reaches a different call does nothing and says so", async () => {
    const other = "/Users/owner/Notes/other.md";
    const h = setup([NOTES, other]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    await h.approve(card.id, tok.get(card.id) ?? "");
    await h.settle();
    expect(h.written).toEqual([]);
    // It asked again for what it did reach, and the owner is told the approval did nothing.
    const pending = await h.pendingCards();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).not.toBe(card.id);
    const notes = await h.notifier.list();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: "approval",
      title: "Weekly notes: the approved action was not done",
      message: {
        titleKey: RESUME_MISSED_TITLE_KEY,
        bodyKey: RESUME_MISSED_BODY_KEY,
        params: { automation: "Weekly notes", why: "not_reached" },
      },
    });
    // Told once: a restart afterwards does not report the same card again.
    await h.restart();
    expect(await missed(h)).toEqual(["not_reached"]);
  });

  it("approved while a run is going: that run's end starts the resume run", async () => {
    const h = setup([NOTES, "/Users/owner/Notes/x.md", NOTES]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    // A second run is in progress (it set another action aside) when the owner approves.
    h.holdRuns(true);
    await h.scheduler.trigger(a.id);
    await new Promise((r) => setImmediate(r));
    await h.approve(card.id, tok.get(card.id) ?? "");
    await h.resume.idle();
    expect(h.scheduler.isRunning(a.id)).toBe(true);
    expect(h.written).toEqual([]);
    h.holdRuns(false);
    h.release();
    await h.settle();
    expect(h.written).toEqual([NOTES]);
  });

  it("an automation that is gone cannot be approved (nothing would run)", async () => {
    const h = setup([NOTES]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    await h.scheduler.remove(a.id);
    await expect(h.approve(card.id, tok.get(card.id) ?? "")).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "not_resumable" },
    });
    expect((await h.broker.get(card.id))?.status).toBe("pending");
    // Decline still works.
    await h.broker.answer({
      approvalId: card.id,
      answerToken: tok.get(card.id) ?? "",
      decision: "deny",
      decidedBy: { deviceId: "dev_mac", surface: "desktop" },
    });
    expect((await h.broker.get(card.id))?.status).toBe("denied");
  });

  it("declining starts nothing", async () => {
    const h = setup([NOTES, NOTES]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    await h.broker.answer({
      approvalId: card.id,
      answerToken: tok.get(card.id) ?? "",
      decision: "deny",
      decidedBy: { deviceId: "dev_mac", surface: "desktop" },
    });
    await h.settle();
    expect(h.written).toEqual([]);
    expect(h.scheduler.runs(a.id).runs).toHaveLength(1);
  });
});

/** The "not done" notices, with their reason. */
async function missed(h: ReturnType<typeof setup>) {
  return (await h.notifier.list())
    .filter((n) => n.message?.titleKey === RESUME_MISSED_TITLE_KEY)
    .map((n) => n.message?.params?.why);
}

describe("R2-2: approving never restarts an automation the owner turned off", () => {
  it("paused before the tap: the approval is refused and nothing runs", async () => {
    const h = setup([NOTES, NOTES]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    await h.scheduler.update(a.id, { enabled: false });
    await expect(h.approve(card.id, tok.get(card.id) ?? "")).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "not_resumable" },
    });
    await h.settle();
    expect((await h.broker.get(card.id))?.status).toBe("pending");
    expect(h.written).toEqual([]);
    expect(h.scheduler.runs(a.id).runs).toHaveLength(1);
  });

  it("positive control: switched back on, the same card approves and resumes", async () => {
    const h = setup([NOTES, NOTES]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    await h.scheduler.update(a.id, { enabled: false });
    await h.scheduler.update(a.id, { enabled: true });
    expect((await h.approve(card.id, tok.get(card.id) ?? "")).status).toBe("approved");
    await h.settle();
    expect(h.written).toEqual([NOTES]);
  });

  it("paused between the tap and the resume: no run, and the owner is told", async () => {
    const h = setup([NOTES, "/Users/owner/Notes/x.md", NOTES]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    h.holdRuns(true);
    await h.scheduler.trigger(a.id);
    await new Promise((r) => setImmediate(r));
    await h.approve(card.id, tok.get(card.id) ?? "");
    await h.resume.idle();
    await h.scheduler.update(a.id, { enabled: false });
    h.holdRuns(false);
    h.release();
    await h.settle();
    expect(h.written).toEqual([]);
    expect(h.scheduler.runs(a.id).runs).toHaveLength(2);
    expect(await missed(h)).toEqual(["paused"]);
  });

  it("a built-in routine paused in Scheduled (enabled stays on) is not resumed", async () => {
    const h = setup([NOTES, NOTES]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    const paused = new DeferredResume({
      scheduler: h.scheduler,
      notifier: h.notifier,
      clock: h.clock,
      isPaused: (x) => x.id === a.id,
    });
    expect(await paused.canResume(card)).toBe(false);
    expect(await h.resume.canResume(card)).toBe(true);
    void tok;
  });
});

describe("silent misses: the owner is told when a promised resume can't happen", () => {
  it("the approval ran out before the resume could start", async () => {
    const h = setup([NOTES, "/Users/owner/Notes/x.md", NOTES]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    h.holdRuns(true);
    await h.scheduler.trigger(a.id);
    await new Promise((r) => setImmediate(r));
    await h.approve(card.id, tok.get(card.id) ?? "");
    await h.resume.idle();
    // The run in progress takes longer than the card's 30 minutes.
    h.clock.advance(31 * 60_000);
    h.holdRuns(false);
    h.release();
    await h.settle();
    expect(h.written).toEqual([]);
    expect(h.scheduler.runs(a.id).runs).toHaveLength(2);
    expect(await missed(h)).toEqual(["expired"]);
  });

  it("a restart revoked the approval before any run used it", async () => {
    const h = setup([NOTES, "/Users/owner/Notes/x.md"]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    // Approved while another run is going, so it is still unused when the Gateway restarts.
    h.holdRuns(true);
    await h.scheduler.trigger(a.id);
    await new Promise((r) => setImmediate(r));
    await h.approve(card.id, tok.get(card.id) ?? "");
    await h.resume.idle();
    const after = await h.restart();
    expect(await missed(h)).toEqual(["restart"]);
    const n = (await h.notifier.list()).find(
      (x) => x.message?.titleKey === RESUME_MISSED_TITLE_KEY,
    );
    expect(n?.title).toBe("Weekly notes: the approved action was not done");
    expect(n?.body).toMatch(/restarted/);
    // The revoked approval cannot be used by anything after the restart.
    expect((await after.broker.verifyBinding(card.id, card.bindingHash)).ok).toBe(false);
    h.release();
  });
});

describe("follow-ups: a failed action is not done, and the restart notice is honest", () => {
  it("a resumed action that ran and failed gets a 'failed' notice, not silence", async () => {
    const h = setup([NOTES, NOTES], { failWrites: true });
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    await h.approve(card.id, tok.get(card.id) ?? "");
    await h.settle();
    expect(h.written).toEqual([]);
    expect(await missed(h)).toEqual(["failed"]);
    const n = (await h.notifier.list()).find(
      (x) => x.message?.titleKey === RESUME_MISSED_TITLE_KEY,
    );
    expect(n?.body).toMatch(/it failed/);
  });

  it("positive control: a resumed action that succeeded gets no notice", async () => {
    const h = setup([NOTES, NOTES]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    await h.approve(card.id, tok.get(card.id) ?? "");
    await h.settle();
    expect(h.written).toEqual([NOTES]);
    expect(await missed(h)).toEqual([]);
  });

  async function lost(scope: "once" | "always", grantId: string | null) {
    const h = setup([NOTES]);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    // As the broker reports it at boot: approved with that scope, its resume cut short.
    h.resume.revokedAtRestart({ ...card, status: "approved", scopeGranted: scope, grantId });
    await h.resume.idle();
    return (await h.notifier.list()).find((x) => x.message?.titleKey === RESUME_MISSED_TITLE_KEY);
  }

  it("a standing approval that keeps its grant: the next run uses it, never 'ask again'", async () => {
    const n = await lost("always", "grt_1");
    expect(n?.message?.params?.why).toBe("restart_kept");
    expect(n?.body).toMatch(/permission you gave stays/);
    expect(n?.body).toMatch(/Standing permissions/);
    expect(n?.body).not.toMatch(/ask again/);
  });

  it("a once approval: nothing was done, and it will ask again", async () => {
    const n = await lost("once", null);
    expect(n?.message?.params?.why).toBe("restart");
    expect(n?.body).toMatch(/ask again/);
    expect(n?.body).not.toMatch(/permission you gave stays/);
  });

  it("an approval whose action failed before the restart says it failed", async () => {
    const h = setup([NOTES]);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    h.resume.revokedAtRestart(
      { ...card, status: "approved", scopeGranted: "always" },
      { failed: true },
    );
    await h.resume.idle();
    expect(await missed(h)).toEqual(["failed"]);
  });
});

describe("follow-ups: a standing grant's use is done only when its call succeeded", () => {
  async function viaGrant(opts: {
    failWrites?: boolean;
    noReceipt?: boolean;
    unrelatedOk?: boolean;
    uncertain?: boolean;
  }) {
    const h = setup([NOTES, NOTES], { ...opts, standing: true });
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    expect(card.scopesOffered).toContain("always");
    const done = await h.approve(card.id, tok.get(card.id) ?? "", "always");
    expect(done.grantId).not.toBeNull();
    await h.settle();
    const n = (await h.notifier.list()).find(
      (x) => x.message?.titleKey === RESUME_MISSED_TITLE_KEY,
    );
    return { h, n };
  }

  it("the grant let the call through and it failed: a failed notice, never 'ask again'", async () => {
    const { h, n } = await viaGrant({ failWrites: true });
    expect(h.written).toEqual([]);
    expect(await missed(h)).toEqual(["failed_kept"]);
    expect(n?.body).toMatch(/it failed/);
    expect(n?.body).toMatch(/try again without asking/);
    expect(n?.body).toMatch(/Standing permissions/);
    expect(n?.body).not.toMatch(/ask again/);
  });

  it("the grant let the call through and no receipt came: outcome unknown, not done", async () => {
    const { h, n } = await viaGrant({ noReceipt: true });
    expect(await missed(h)).toEqual(["unknown"]);
    expect(n?.body).toMatch(/can't tell whether it worked/);
    expect(n?.body).toMatch(/Check Activity/);
    expect(n?.body).not.toMatch(/it failed/);
    // Over: no resume run does it again.
    expect(h.resume.pending()).toEqual([]);
  });

  it("an unrelated ok receipt of the same kind (no grant id) does not make it done", async () => {
    const { h } = await viaGrant({ unrelatedOk: true, noReceipt: true });
    expect(await missed(h)).toEqual(["unknown"]);
  });

  it("an unrelated ok receipt does not hide the grant's failed call", async () => {
    const { h } = await viaGrant({ unrelatedOk: true, failWrites: true });
    expect(await missed(h)).toEqual(["failed_kept"]);
  });

  it("the provider did not confirm the grant's call: outcome unknown", async () => {
    const { h } = await viaGrant({ uncertain: true });
    expect(await missed(h)).toEqual(["unknown"]);
  });

  it("positive control: a gmail.send whose ok receipt carries the grant id: done, no notice", async () => {
    const { h, n } = await viaGrant({});
    expect(h.written).toEqual([NOTES]);
    expect(n).toBeUndefined();
    expect(h.resume.pending()).toEqual([]);
  });

  it("a once approval that failed still says it will ask again", async () => {
    const h = setup([NOTES, NOTES], { failWrites: true });
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    await h.approve(card.id, tok.get(card.id) ?? "", "once");
    await h.settle();
    expect(await missed(h)).toEqual(["failed"]);
  });

  it("a kept grant whose action failed before the restart: failed, with the kept wording", async () => {
    const h = setup([NOTES]);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    h.resume.revokedAtRestart(
      { ...card, status: "approved", scopeGranted: "always", grantId: "grt_1" },
      { failed: true },
    );
    await h.resume.idle();
    expect(await missed(h)).toEqual(["failed_kept"]);
  });
});

describe("follow-ups: only this automation's own run of this very action counts", () => {
  const OTHER = "/Users/owner/Notes/other.md";

  it("an attended chat send through the same grant does not settle the entry", async () => {
    const h = setup([NOTES, OTHER, NOTES], { standing: true });
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    // A second run is going when the owner approves "always": the resume waits for it.
    h.holdRuns(true);
    await h.scheduler.trigger(a.id);
    await new Promise((r) => setImmediate(r));
    await h.approve(card.id, tok.get(card.id) ?? "", "always");
    await h.resume.idle();
    // Meanwhile the owner's own chat sends the same thing through the same grant.
    const chat = { threadId: "thr_chat", runId: "run_chat", taskId: "task_chat" };
    const d = await h.broker.decide(connectorCall(NOTES), {
      ...chat,
      permissionMode: "balanced",
      taint: false,
    });
    expect(d.decision).toBe("allow");
    await h.broker.recordReceipt({
      kind: "gmail.send",
      outcome: "ok",
      summary: "Sent from chat",
      taskId: chat.taskId,
      approvalId: null,
      payload: {
        rule: `grant:${d.grantId}`,
        grantId: d.grantId ?? "",
        bindingHash: d.bindingHash ?? "",
      },
    });
    expect(h.resume.pending()).toEqual([card.id]);
    h.holdRuns(false);
    h.release();
    await h.settle();
    // The automation's own resume run still did it, and it is done: no notice.
    expect(h.written).toEqual([NOTES]);
    expect(await missed(h)).toEqual([]);
    expect(h.resume.pending()).toEqual([]);
  });

  it("another action through the grant in the automation's resume run: not reached, kept wording", async () => {
    const h = setup([NOTES, OTHER], { standing: true });
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    await h.approve(card.id, tok.get(card.id) ?? "", "always");
    await h.settle();
    // The resume run did another write under the same grant, with its own ok receipt.
    expect(h.written).toEqual([OTHER]);
    // Not reached; the `always` grant stays, so the next run does it without asking.
    expect(await missed(h)).toEqual(["not_reached_kept"]);
    const n = (await h.notifier.list()).find(
      (x) => x.message?.titleKey === RESUME_MISSED_TITLE_KEY,
    );
    expect(n?.body).toMatch(/did not reach the same action/);
    expect(n?.body).toMatch(/permission you gave stays/);
    expect(n?.body).toMatch(/Standing permissions/);
    expect(n?.body).not.toMatch(/ask again/);
  });

  it("a once approval not reached by its resume run: not_reached, it will ask again", async () => {
    const h = setup([NOTES, OTHER, OTHER]);
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    const card = await h.issued();
    await h.approve(card.id, tok.get(card.id) ?? "", "once");
    await h.settle();
    expect(await missed(h)).toEqual(["not_reached"]);
    const n = (await h.notifier.list()).find(
      (x) => x.message?.titleKey === RESUME_MISSED_TITLE_KEY,
    );
    expect(n?.body).toMatch(/ask again/);
    expect(n?.body).not.toMatch(/permission you gave stays/);
  });
});

describe("follow-ups: a run that uses the grant as soon as it exists does it once", () => {
  /**
   * The card is approved "always" while a second run of the automation is going, and that run
   * makes the same call through the new grant before the decision reaches DeferredResume.
   */
  async function raced(opts: { failWrites?: boolean; unrelatedUses?: number } = {}) {
    const { unrelatedUses, ...rest } = opts;
    const h = setup([NOTES, OTHER_PATH, NOTES], { standing: true, holdDecided: true, ...rest });
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    h.deliverDecided();
    const card = await h.issued();
    h.holdRuns(true);
    await h.scheduler.trigger(a.id);
    await new Promise((r) => setImmediate(r));
    await h.approve(card.id, tok.get(card.id) ?? "", "always");
    // The going run (task_2) sends it through the grant right away, with its receipt.
    const d = await h.broker.decide(connectorCall(NOTES), {
      threadId: "thr",
      runId: "run_2",
      taskId: "task_2",
      permissionMode: "balanced",
      taint: false,
      unattended: true,
    });
    expect(d.decision).toBe("allow");
    await h.broker.recordReceipt({
      kind: "gmail.send",
      outcome: opts.failWrites === true ? "failed" : "ok",
      summary: "Sent",
      taskId: "task_2",
      approvalId: null,
      payload: { grantId: d.grantId ?? "", bindingHash: d.bindingHash ?? "" },
    });
    if (unrelatedUses !== undefined) {
      // The owner's own chat, in the same gap, works under an attended "always" grant (another
      // connector action, so not the card's grant).
      const chatCall: PolicyCall = { ...connectorCall(OTHER_PATH), tool: "chat.action" };
      const chat = {
        threadId: "thr_chat",
        runId: "run_chat",
        taskId: "task_chat",
        permissionMode: "balanced" as const,
        taint: false,
      };
      const ask = await h.broker.decide(chatCall, chat);
      expect(ask.decision).toBe("ask");
      const issued = await h.broker.requestApproval({
        kind: ask.approvalKind ?? "connector_action",
        summary: "Chat send",
        details: {},
        bindingHash: ask.bindingHash ?? "",
        grantKey: ask.grantKey ?? "k",
        requestedBy: { runId: chat.runId, taskId: chat.taskId, threadId: chat.threadId },
        sideEffect: "write",
        surfaces: ["desktop"],
        taint: false,
      });
      expect(issued.approval.setAside).toBeUndefined();
      await h.approve(issued.approval.id, tok.get(issued.approval.id) ?? "", "always");
      for (let i = 0; i < unrelatedUses; i++) {
        const u = await h.broker.decide(chatCall, chat);
        expect(u.grantId).toBeDefined();
        expect(u.grantId).not.toBe(d.grantId);
      }
    }
    // Only now does the decision arrive.
    h.deliverDecided();
    await h.resume.idle();
    h.holdRuns(false);
    h.release();
    await h.settle();
    return { h, card, automationId: a.id };
  }

  it("done once by the going run: no resume run does it a second time", async () => {
    const { h, automationId } = await raced();
    // Two runs only (the one that set it aside, the one that did it): no resume run.
    expect(h.launches()).toBe(2);
    expect(h.scheduler.runs(automationId).runs).toHaveLength(2);
    expect(h.written).toEqual([]);
    expect(await missed(h)).toEqual([]);
    expect(h.resume.pending()).toEqual([]);
  });

  it("300 uses of an attended grant in the gap do not evict the card's early use", async () => {
    const { h, automationId } = await raced({ unrelatedUses: 300 });
    expect(h.launches()).toBe(2);
    expect(h.scheduler.runs(automationId).runs).toHaveLength(2);
    expect(h.written).toEqual([]);
    expect(await missed(h)).toEqual([]);
  });

  it("the going run's call through the grant failed: failed_kept, and no second try by a resume", async () => {
    const { h } = await raced({ failWrites: true });
    expect(h.launches()).toBe(2);
    expect(await missed(h)).toEqual(["failed_kept"]);
  });

  it("positive control: without that call the resume run does it (once)", async () => {
    const h = setup([NOTES, OTHER_PATH, NOTES], { standing: true, holdDecided: true });
    const tok = tokens(h);
    const a = await h.scheduler.create(automation);
    await h.scheduler.trigger(a.id);
    await h.settle();
    h.deliverDecided();
    const card = await h.issued();
    h.holdRuns(true);
    await h.scheduler.trigger(a.id);
    await new Promise((r) => setImmediate(r));
    await h.approve(card.id, tok.get(card.id) ?? "", "always");
    h.deliverDecided();
    await h.resume.idle();
    h.holdRuns(false);
    h.release();
    await h.settle();
    expect(h.launches()).toBe(3);
    expect(h.written).toEqual([NOTES]);
    expect(await missed(h)).toEqual([]);
  });
});

const OTHER_PATH = "/Users/owner/Notes/other.md";
