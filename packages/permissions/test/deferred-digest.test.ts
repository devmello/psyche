import { describe, expect, it } from "vitest";
import type { PolicyApprovalInput } from "../src/index.ts";
import { riskClassFor } from "../src/risk.ts";
import { makeBroker } from "./helpers.ts";

// The risk table: `routine` only for the bulk-approvable kinds, untainted, payment-free, with a
// local side effect. Every near-miss below must stay `sensitive`.
describe("riskClassFor (Approve all routine ones)", () => {
  const base = { requiresAuthentication: false, taint: false } as const;

  it.each([
    ["file_write", "write"],
    ["git_write", "write"],
    ["archive_thread", "none"],
    ["task_start", "read"],
  ] as const)("routine: %s with side effect %s", (kind, sideEffect) => {
    expect(riskClassFor({ ...base, kind, sideEffect })).toBe("routine");
  });

  it.each([
    ["send_email", "write"],
    ["message_send", "write"],
    ["purchase", "financial"],
    ["file_write", "destructive"],
    ["file_write", "financial"],
    ["connector_action", "write"],
    ["exec_host", "write"],
    ["file_write", undefined],
  ] as const)("sensitive: %s with side effect %s", (kind, sideEffect) => {
    expect(riskClassFor({ ...base, kind, sideEffect })).toBe("sensitive");
  });

  it("sensitive when tainted, when a tap needs presence, or when the classifier objects", () => {
    expect(riskClassFor({ ...base, kind: "file_write", sideEffect: "write", taint: true })).toBe(
      "sensitive",
    );
    expect(
      riskClassFor({
        ...base,
        kind: "file_write",
        sideEffect: "write",
        requiresAuthentication: true,
      }),
    ).toBe("sensitive");
    expect(
      riskClassFor({
        kind: "file_write",
        sideEffect: "write",
        ...base,
        classifierLabel: "sensitive",
      }),
    ).toBe("sensitive");
    expect(
      riskClassFor({
        kind: "file_write",
        sideEffect: "write",
        ...base,
        classifierLabel: "prohibited",
      }),
    ).toBe("prohibited");
  });
});

const deferredInput = (taskId: string, extra: Partial<PolicyApprovalInput> = {}) =>
  ({
    kind: "file_write",
    summary: "Write the weekly notes",
    details: {},
    bindingHash: `bh_${taskId}_${Math.random()}`,
    grantKey: "file_write|notes",
    requestedBy: { runId: "run_auto", taskId, threadId: null },
    sideEffect: "write",
    surfaces: ["desktop", "web"],
    taint: false,
    ...extra,
  }) as PolicyApprovalInput;

describe("automation digest in the broker", () => {
  it("a deferred card gets no notice of its own; an owner's card still does", async () => {
    const h = makeBroker({
      deferredApproval: (a) => a.requestedBy.taskId === "task_auto",
    });
    const deferred = await h.broker.requestApproval(deferredInput("task_auto"));
    expect(deferred.approval.riskClass).toBe("routine");
    expect(await h.notifier.list({ unresolvedOnly: true })).toHaveLength(0);

    await h.broker.requestApproval(deferredInput("task_owner"));
    expect(await h.notifier.list({ unresolvedOnly: true })).toHaveLength(1);
  });

  it("approving a deferred card resumes the waiting action through the answer path", async () => {
    const h = makeBroker({
      deferredApproval: (a) => a.requestedBy.taskId === "task_auto",
    });
    const issued = await h.broker.requestApproval(deferredInput("task_auto"));
    const waiting = h.broker.awaitDecision(issued.approval.id);
    h.clock.advance(500);
    const answered = await h.broker.answer(
      {
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decision: "approve",
        scope: "once",
        decidedBy: { deviceId: "dev_mac", surface: "desktop" },
      },
      { local: true },
    );
    expect(answered.status).toBe("approved");
    expect((await waiting).status).toBe("approved");
  });

  it("an expired deferred card is shown as expired and cannot run late", async () => {
    const h = makeBroker({
      deferredApproval: (a) => a.requestedBy.taskId === "task_auto",
    });
    const issued = await h.broker.requestApproval(deferredInput("task_auto"));
    const waiting = h.broker.awaitDecision(issued.approval.id);
    h.clock.advance(30 * 60_000);
    expect((await waiting).status).toBe("expired");
    await expect(
      h.broker.answer(
        {
          approvalId: issued.approval.id,
          answerToken: issued.answerTokens.desktop ?? "",
          decision: "approve",
          scope: "once",
          decidedBy: { deviceId: "dev_mac", surface: "desktop" },
        },
        { local: true },
      ),
    ).rejects.toThrow();
  });
});
