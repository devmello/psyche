import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DeferredList } from "../src/agent/ApprovalsPanel.tsx";
import type { ApprovalView } from "../src/data/hooks.ts";

const NOW = Date.parse("2026-11-18T10:30:00Z");

function view(id: string, extra: Partial<ApprovalRequest> = {}, canAnswer = true): ApprovalView {
  return {
    approval: {
      id,
      kind: "file_write",
      summary: `Write ${id}.md`,
      status: "pending",
      riskClass: "routine",
      setAside: true,
      requiresAuthentication: false,
      deviceOnly: false,
      details: {},
      target: { kind: "path", value: `/Users/owner/Notes/deep/${id}.md` },
      requestedBy: { runId: "run_1", taskId: "task_auto", threadId: null },
      requestedAt: "2026-11-18T10:00:00Z",
      expiresAt: "2026-11-18T10:30:00Z",
      ...extra,
    } as ApprovalRequest,
    canAnswer,
    stale: false,
  };
}

const TASKS = { task_auto: { title: "Weekly notes" } } as never;

function rowOf(id: string): HTMLElement {
  const row = screen
    .getAllByTestId("deferred-row")
    .find((r) => r.getAttribute("data-approval-id") === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
}

describe("DeferredList", () => {
  it("shows the automation, the action and the full path of a write", () => {
    render(<DeferredList items={[view("a1")]} tasks={TASKS} now={NOW} answer={vi.fn()} />);
    const row = rowOf("a1");
    expect(within(row).getByText("Weekly notes")).toBeTruthy();
    expect(within(row).getByTestId("deferred-path").textContent).toBe(
      "/Users/owner/Notes/deep/a1.md",
    );
    expect(within(row).getByText(/Routine/)).toBeTruthy();
  });

  it("Approve all routine ones sends bulk, once, for the routine rows only", async () => {
    const answer = vi.fn(async () => ({}) as never);
    render(
      <DeferredList
        items={[view("a1"), view("a2"), view("x", { riskClass: "sensitive" }, false)]}
        tasks={TASKS}
        now={NOW}
        answer={answer}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Approve all routine ones \(2\)/ }));
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
    expect(answer).toHaveBeenCalledWith("a1", "approve", "once", { bulk: true });
    expect(answer).toHaveBeenCalledWith("a2", "approve", "once", { bulk: true });
    // Approving a set-aside action says what happens next, not "done".
    expect((await screen.findByTestId("deferred-resuming")).textContent).toMatch(
      /Running Weekly notes again/,
    );
  });

  it("a row answered on another device has no buttons and no bulk", () => {
    render(
      <DeferredList
        items={[view("x", { riskClass: "sensitive" }, false)]}
        tasks={TASKS}
        now={NOW}
        answer={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(within(rowOf("x")).getByText("Answer where it was sent")).toBeTruthy();
  });

  it("one row's Approve and Decline answer that card alone, without bulk", async () => {
    const answer = vi.fn(async () => ({}) as never);
    render(<DeferredList items={[view("a1")]} tasks={TASKS} now={NOW} answer={answer} />);
    await userEvent.click(within(rowOf("a1")).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith("a1", "deny", undefined, undefined));
    await userEvent.click(within(rowOf("a1")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith("a1", "approve", "once", undefined));
  });

  it("a refused approval shows what to do, and does not claim the run started", async () => {
    const err = Object.assign(new Error("this automation can't run again"), {
      code: "unavailable",
      details: { reason: "not_resumable" },
    });
    const answer = vi.fn(async () => {
      throw err;
    });
    render(<DeferredList items={[view("a1")]} tasks={TASKS} now={NOW} answer={answer} />);
    await userEvent.click(within(rowOf("a1")).getByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/can't run again/);
    expect(screen.queryByTestId("deferred-resuming")).toBeNull();
  });
});
