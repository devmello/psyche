import type { ApprovalRequest } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { routineDeferred } from "../src/agent/deferred-digest.ts";
import type { ApprovalView } from "../src/data/hooks.ts";

function view(id: string, extra: Partial<ApprovalRequest> = {}, canAnswer = true): ApprovalView {
  return {
    approval: {
      id,
      status: "pending",
      riskClass: "routine",
      requiresAuthentication: false,
      ...extra,
    } as ApprovalRequest,
    canAnswer,
    stale: false,
  };
}

describe("Approve all routine ones", () => {
  it("covers only the routine cards and skips sensitive and prohibited ones", () => {
    const views = [
      view("r1"),
      view("s1", { riskClass: "sensitive" }),
      view("p1", { riskClass: "prohibited" }),
      view("u1", { riskClass: undefined }),
      view("r2"),
    ];
    expect(routineDeferred(views).map((v) => v.approval.id)).toEqual(["r1", "r2"]);
  });

  it("never covers a payment, even when labelled routine", () => {
    expect(routineDeferred([view("pay", { requiresAuthentication: true })])).toEqual([]);
  });

  it("needs an answer token on this window", () => {
    expect(routineDeferred([view("r1", {}, false)])).toEqual([]);
  });
});
