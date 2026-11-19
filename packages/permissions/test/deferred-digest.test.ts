import { describe, expect, it } from "vitest";
import type { PolicyApprovalInput, PolicyCall, PolicyContext } from "../src/index.ts";
import { pathCarriesExecution, riskClassFor } from "../src/risk.ts";
import { CTX, call, DEVICE, type Harness, makeBroker, path } from "./helpers.ts";

// The risk class comes from the broker's own `decide` (its rule), driven for real here: the card
// is routine only for a plain mode-default write ask. Each row is a near-miss that must not be.

// Manual mode asks for every write, so a write in a granted folder reaches the mode default.
const UNATTENDED: PolicyContext = {
  ...CTX,
  runId: "run_auto",
  permissionMode: "manual",
  unattended: true,
};
const FOLDERS = [{ path: "/Users/owner", mode: "rw" as const }];
/** A broker with the owner's home granted read-write (so file writes are not denied). */
const mk = (options: Parameters<typeof makeBroker>[0] = {}) =>
  makeBroker({ ...options, policy: { folders: FOLDERS, ...(options.policy ?? {}) } });
const NOTES = "/Users/owner/Notes/weekly.md";

/** decide → requestApproval as the agent loop does for an unattended run. */
async function issue(
  h: Harness,
  c: PolicyCall,
  ctx: PolicyContext = UNATTENDED,
  extra: Partial<PolicyApprovalInput> = {},
) {
  const d = await h.broker.decide(c, ctx);
  if (d.decision !== "ask" || d.approvalKind === undefined || d.bindingHash === undefined) {
    throw new Error(`expected ask, got ${d.decision} (${d.rule})`);
  }
  const issued = await h.broker.requestApproval({
    kind: d.approvalKind,
    summary: `test ${c.tool}`,
    details: {},
    bindingHash: d.bindingHash,
    grantKey: d.grantKey ?? "k",
    requestedBy: { runId: ctx.runId, taskId: ctx.taskId ?? null, threadId: ctx.threadId },
    sideEffect: c.sideEffect,
    ...(c.target === undefined ? {} : { target: c.target }),
    surfaces: ["desktop"],
    taint: ctx.taint,
    setAside: true,
    ...extra,
  });
  return { d, issued };
}

const write = (p: string, extra: Partial<PolicyCall> = {}) =>
  call("write_file", "write", path(p), extra);

describe("riskClass from the decision that asked (real decide)", () => {
  it("positive control: a plain mode-default file write is routine", async () => {
    const h = mk();
    const { d, issued } = await issue(h, write(NOTES));
    expect(d.rule).toBe("mode:manual/write");
    expect(issued.approval.riskClass).toBe("routine");
    expect(issued.approval.setAside).toBe(true);
  });

  it("positive control: a mode-default git commit through code.git is routine", async () => {
    const h = mk();
    const c = call("code.git", "write", path("/Users/owner/src/app"), { kind: "git_write" });
    const { d, issued } = await issue(h, c);
    expect(d.rule).toBe("mode:manual/write");
    expect(issued.approval.riskClass).toBe("routine");
  });

  it("B1: a write the Auto classifier called sensitive is sensitive", async () => {
    const h = mk();
    const c = write(NOTES);
    // A granted folder puts the write in Auto's classifier step; no owner messages → sensitive.
    const { d, issued } = await issue(h, c, {
      ...UNATTENDED,
      permissionMode: "auto",
      ownerMessages: [],
    });
    expect(d.rule).toBe("classifier:sensitive");
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("a tainted run's write (taint:*) is sensitive", async () => {
    const h = mk();
    const { d, issued } = await issue(h, write(NOTES), {
      ...UNATTENDED,
      taint: true,
      newTarget: true,
    });
    expect(d.rule.startsWith("taint:")).toBe(true);
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("an owner ask rule (policy:ask:*) is sensitive", async () => {
    const h = mk({ policy: { ask: ["write_file"] } });
    const { d, issued } = await issue(h, write(NOTES));
    expect(d.rule).toBe("policy:ask:write_file");
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("a destructive call is sensitive", async () => {
    const h = mk();
    const c = call("thread_archive", "destructive", undefined, { kind: "archive_thread" });
    const { d, issued } = await issue(h, c);
    expect(d.rule).toBe("mode:manual/destructive");
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("a relabelled call (a connector tool claiming file_write) is sensitive", async () => {
    const h = mk();
    const c = call("conn.action", "write", path(NOTES), { kind: "file_write" });
    const { d, issued } = await issue(h, c);
    expect(d.approvalKind).toBe("file_write");
    expect(d.rule).toBe("mode:manual/write");
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("git_write from a tool other than code.git is sensitive", async () => {
    const h = mk();
    const c = call("conn.action", "write", path("/Users/owner/src/app"), { kind: "git_write" });
    expect((await issue(h, c)).issued.approval.riskClass).toBe("sensitive");
  });

  it.each([
    "/Users/owner/src/app/.envrc",
    "/Users/owner/src/app/Makefile",
    "/Users/owner/src/app/package.json",
    "/Users/owner/src/app/.vscode/tasks.json",
    "/Users/owner/src/app/.github/workflows/ci.yml",
    "/Users/owner/src/app/.husky/pre-commit",
    "/Users/owner/.zshrc",
    "/Users/owner/.bash_profile",
    "/Users/owner/.config/fish/config.fish",
    "/Users/owner/Library/LaunchAgents/com.example.agent.plist",
    "/Users/owner/src/app/rules.mk",
  ])("a write to %s (carries execution) is sensitive", async (p) => {
    const h = mk();
    expect((await issue(h, write(p))).issued.approval.riskClass).toBe("sensitive");
  });

  it.each([
    "/Users/owner/Notes/Makefile notes.md",
    "/Users/owner/src/app/docs/package.md",
    "/Users/owner/src/app/src/envrc.ts",
    "/Users/owner/Notes/vscode/tasks.md",
  ])("near-miss: %s is an ordinary file and stays routine", async (p) => {
    const h = mk();
    expect((await issue(h, write(p))).issued.approval.riskClass).toBe("routine");
  });

  it("no decision at all (a card issued without decide) is sensitive", async () => {
    const h = mk();
    const issued = await h.broker.requestApproval({
      kind: "file_write",
      summary: "Write notes",
      details: {},
      bindingHash: "sha256:none",
      grantKey: "k",
      requestedBy: { runId: "run_auto", taskId: "task_1", threadId: "thr_main" },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: false,
    });
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("another run's decision under the same binding does not count", async () => {
    const h = mk();
    const c = write(NOTES);
    const { issued } = await issue(h, c, UNATTENDED, {
      requestedBy: { runId: "run_other", taskId: "task_1", threadId: "thr_main" },
    });
    expect(issued.approval.riskClass).toBe("sensitive");
    expect(issued.approval.setAside).toBeUndefined();
  });

  it("a device-only card is sensitive", async () => {
    const h = mk();
    const { issued } = await issue(h, write(NOTES), UNATTENDED, { deviceOnly: true });
    expect(issued.approval.riskClass).toBe("sensitive");
  });

  it("a non-owner requester makes it sensitive (unit, same decision otherwise routine)", () => {
    const base = {
      kind: "file_write" as const,
      sideEffect: "write" as const,
      requiresAuthentication: false,
      taint: false,
      deviceOnly: false,
      typedConfirmation: false,
    };
    const recent = (ctx: PolicyContext) => ({
      call: write(NOTES),
      ctx,
      decision: {
        decision: "ask" as const,
        rule: "mode:manual/write",
        approvalKind: "file_write" as const,
        sideEffect: "write" as const,
        trace: [],
        call: write(NOTES),
      },
      fields: {},
    });
    expect(riskClassFor({ ...base, recent: recent(UNATTENDED) })).toBe("routine");
    expect(
      riskClassFor({
        ...base,
        recent: recent({ ...UNATTENDED, requester: { role: "designated", identityId: "idn_1" } }),
      }),
    ).toBe("sensitive");
    expect(riskClassFor({ ...base, typedConfirmation: true, recent: recent(UNATTENDED) })).toBe(
      "sensitive",
    );
    expect(
      riskClassFor({ ...base, requiresAuthentication: true, recent: recent(UNATTENDED) }),
    ).toBe("sensitive");
  });

  it("pathCarriesExecution: a bare or empty path fails closed", () => {
    expect(pathCarriesExecution("")).toBe(true);
    expect(pathCarriesExecution("/")).toBe(true);
    expect(pathCarriesExecution("/Users/owner/Notes/a.md")).toBe(false);
  });
});

const answerAs = (
  h: Harness,
  issued: { approval: { id: string }; answerTokens: Record<string, string> },
  extra: { bulk?: true; scope?: "once" | "always" } = {},
) =>
  h.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope: extra.scope ?? "once",
    decidedBy: DEVICE,
    ...(extra.bulk === undefined ? {} : { bulk: extra.bulk }),
  });

describe("bulk answers are checked by the broker", () => {
  it("bulk approves a routine card (positive control) and refuses a sensitive one", async () => {
    const h = mk({ canResume: () => true });
    const routine = await issue(h, write(NOTES));
    const sensitive = await issue(h, write("/Users/owner/.zshrc"));
    h.clock.advance(500);
    expect((await answerAs(h, routine.issued, { bulk: true })).status).toBe("approved");
    await expect(answerAs(h, sensitive.issued, { bulk: true })).rejects.toMatchObject({
      code: "invalid_params",
      details: { reason: "not_routine" },
    });
    // Its own tap still works: bulk is refused, the card is not.
    expect((await answerAs(h, sensitive.issued)).status).toBe("approved");
  });

  it("a refused bulk answer never counts toward the owner's lockout", async () => {
    const h = mk({ canResume: () => true });
    const r = await issue(h, write("/Users/owner/src/app/Makefile"));
    h.clock.advance(500);
    for (let i = 0; i < 80; i++) {
      await expect(answerAs(h, r.issued, { bulk: true })).rejects.toMatchObject({
        details: { reason: "not_routine" },
      });
    }
    expect((await answerAs(h, r.issued)).status).toBe("approved");
  });
});

describe("set-aside cards", () => {
  it("are approved only when a resume run can start (fails closed without one)", async () => {
    const none = mk();
    const a = await issue(none, write(NOTES));
    none.clock.advance(500);
    await expect(answerAs(none, a.issued)).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "not_resumable" },
    });
    expect((await none.broker.get(a.issued.approval.id))?.status).toBe("pending");

    const yes = mk({ canResume: (x) => x.setAside === true });
    const b = await issue(yes, write(NOTES));
    yes.clock.advance(500);
    expect((await answerAs(yes, b.issued)).status).toBe("approved");
  });

  it("a caller that awaits its card (webhook delivery) is never set aside", async () => {
    const h = mk();
    const { issued } = await issue(h, write(NOTES), UNATTENDED, { setAside: undefined });
    expect(issued.approval.setAside).toBeUndefined();
    const waiting = h.broker.awaitDecision(issued.approval.id);
    h.clock.advance(500);
    expect((await answerAs(h, issued)).status).toBe("approved");
    expect((await waiting).status).toBe("approved");
  });

  it("an attended run's ask is never set aside, even when the loop flag is sent", async () => {
    const h = mk();
    const { issued } = await issue(h, write(NOTES), { ...CTX, permissionMode: "manual" });
    expect(issued.approval.setAside).toBeUndefined();
  });
});

describe("automation digest in the broker", () => {
  it("a deferred card gets no notice of its own; an owner's card still does", async () => {
    const h = mk({ deferredApproval: (a) => a.requestedBy.runId === "run_auto" });
    await issue(h, write(NOTES));
    expect(await h.notifier.list({ unresolvedOnly: true })).toHaveLength(0);
    await issue(h, write("/Users/owner/Notes/other.md"), { ...CTX, permissionMode: "manual" });
    expect(await h.notifier.list({ unresolvedOnly: true })).toHaveLength(1);
  });

  it("an expired deferred card cannot be approved late", async () => {
    const h = mk({ canResume: () => true });
    const { issued } = await issue(h, write(NOTES));
    h.clock.advance(30 * 60_000);
    await expect(answerAs(h, issued)).rejects.toThrow();
  });
});
