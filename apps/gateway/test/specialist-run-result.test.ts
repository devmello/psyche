import type { Task } from "@psyche/protocol";
import { NEEDS_APPROVAL_RESULT } from "@psyche/tasks";
import { describe, expect, it } from "vitest";
import { specialistRunResult } from "../src/compose/automation-specialists.ts";

const task = (extra: Partial<Task>): Task => ({ id: "t_1", status: "cancelled", ...extra }) as Task;

describe("specialistRunResult", () => {
  it("a job whose approval ran out reports needsApproval, so the owner gets that notice", () => {
    const r = specialistRunResult(
      task({ summary: "Needs approval", outcome: { result: NEEDS_APPROVAL_RESULT } }),
    );
    expect(r).toMatchObject({ status: "cancelled", needsApproval: true, taskId: "t_1" });
  });

  it("a job cancelled for any other reason does not", () => {
    const r = specialistRunResult(task({ summary: "Stopped" }));
    expect(r.status).toBe("cancelled");
    expect(r.needsApproval).toBeUndefined();
  });
});
