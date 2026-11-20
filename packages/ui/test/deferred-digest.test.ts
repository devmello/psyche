import type { ApprovalRequest } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { routineDeferred, splitApprovals, writePath } from "../src/agent/deferred-digest.ts";
import type { ApprovalView } from "../src/data/hooks.ts";

function view(
  id: string,
  extra: Partial<ApprovalRequest> = {},
  canAnswer = true,
  taskId = "task_auto",
): ApprovalView {
  return {
    approval: {
      id,
      kind: "file_write",
      status: "pending",
      riskClass: "routine",
      requiresAuthentication: false,
      deviceOnly: false,
      details: {},
      requestedBy: { runId: "run_1", taskId, threadId: null },
      ...extra,
    } as ApprovalRequest,
    canAnswer,
    stale: false,
  };
}

const TASKS = {
  task_auto: { createdFrom: "automation" },
  task_chat: { createdFrom: "chat" },
};

describe("Approve all routine ones", () => {
  it("covers only the routine cards (positive control) and skips sensitive ones", () => {
    const views = [
      view("r1"),
      view("s1", { riskClass: "sensitive" }),
      view("u1", { riskClass: undefined }),
      view("r2", { kind: "git_write" }),
    ];
    expect(routineDeferred(views).map((v) => v.approval.id)).toEqual(["r1", "r2"]);
  });

  it.each([
    ["a payment", { requiresAuthentication: true }],
    ["a device-only card", { deviceOnly: true }],
    ["a typed-confirmation card", { details: { confirmationWord: "DELETE" } }],
    ["a folder request", { kind: "folder_access" }],
    ["a compose card", { kind: "message_send" }],
  ] as const)("never covers %s, even when labelled routine", (_name, extra) => {
    expect(routineDeferred([view("x", extra as Partial<ApprovalRequest>)])).toEqual([]);
  });

  it("needs an answer token on this window", () => {
    expect(routineDeferred([view("r1", {}, false)])).toEqual([]);
  });
});

describe("splitApprovals (Needs you vs Deferred)", () => {
  it("routine automation cards are Deferred rows; sensitive ones stay full cards in Needs you", () => {
    const { live, deferred, needsYou } = splitApprovals(
      [
        view("routine"),
        view("sensitive", { riskClass: "sensitive" }),
        view("payment", { requiresAuthentication: true }),
        view("folder", { kind: "folder_access", riskClass: "sensitive" }),
        view("elsewhere", { riskClass: "sensitive" }, false),
        view("chat", {}, true, "task_chat"),
      ],
      TASKS,
    );
    expect(deferred.map((v) => v.approval.id)).toEqual(["routine", "elsewhere"]);
    expect(live.map((v) => v.approval.id)).toEqual(["sensitive", "payment", "folder", "chat"]);
    // Every card this window can answer is counted (badge, Home): the routine row too.
    expect(needsYou).toBe(5);
  });
});

describe("writePath", () => {
  it("is the full path, never the basename", () => {
    expect(
      writePath(view("w", { target: { kind: "path", value: "/Users/o/Notes/w.md" } }).approval),
    ).toBe("/Users/o/Notes/w.md");
    expect(writePath(view("g", { details: { repo: "/Users/o/src/app" } }).approval)).toBe(
      "/Users/o/src/app",
    );
    expect(writePath(view("n").approval)).toBeUndefined();
  });
});
