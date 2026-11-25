import type { Run, ToolCall } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type RunStep, RunStepLog } from "../src/chat/RunStepLog.tsx";
import {
  currentStepLabels,
  isWaitingOnYou,
  KEEP_DONE,
  railItems,
  stepState,
} from "../src/chat/run-progress.ts";
import { createFixtureWorld } from "../src/fixtures/index.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

const NOW = Date.parse("2026-11-19T10:00:00Z");
const world = createFixtureWorld();
const baseRun = world.runs[0] as Run;
const baseCall = world.toolCalls[0] as ToolCall;

function tool(
  id: string,
  status: RunStep["status"],
  label: string,
  at = NOW - 60_000,
  endedAt: number | null = null,
): RunStep {
  return { kind: "tool", id, at, endedAt, status, label, tool: "web.fetch" };
}

describe("stepState", () => {
  it.each([
    ["running", "current"],
    ["waiting", "waiting"],
    ["done", "done"],
    ["failed", "failed"],
    ["blocked", "failed"],
    ["cancelled", "stopped"],
    ["paused", "stopped"],
    ["pending", "stopped"],
  ] as const)("%s reads as %s", (status, state) => {
    expect(stepState({ status })).toBe(state);
  });
});

describe("railItems", () => {
  const done = (n: number) =>
    Array.from({ length: n }, (_, i) => tool(`d${i}`, "done", `Step ${i}`, NOW - 90_000 + i, NOW));

  it("keeps every step when few have finished", () => {
    const items = railItems([...done(KEEP_DONE), tool("now", "running", "Reading")]);
    expect(items.map((i) => i.kind)).toEqual(["step", "step", "step"]);
  });

  it("folds finished steps beyond the last two into one row", () => {
    const items = railItems([...done(5), tool("now", "running", "Reading")]);
    expect(items[0]).toEqual({ kind: "earlier", count: 3 });
    expect(items.filter((i) => i.kind === "step")).toHaveLength(KEEP_DONE + 1);
  });

  it("never folds a failure, a waiting step or the current step", () => {
    const steps = [
      tool("a", "done", "A"),
      tool("bad", "failed", "Bad"),
      tool("b", "done", "B"),
      tool("c", "done", "C"),
      tool("d", "done", "D"),
      tool("ask", "waiting", "Ask"),
      tool("now", "running", "Now"),
    ];
    const ids = railItems(steps)
      .flatMap((i) => (i.kind === "step" ? [i.step.id] : []))
      .sort();
    expect(ids).toEqual(["ask", "bad", "c", "d", "now"]);
  });

  it("shows everything when expanded", () => {
    const items = railItems([...done(6), tool("now", "running", "Reading")], true);
    expect(items.every((i) => i.kind === "step")).toBe(true);
    expect(items).toHaveLength(7);
  });

  it("marks the latest running or waiting step as now", () => {
    const steps = [tool("a", "done", "A"), tool("b", "waiting", "B"), tool("c", "running", "C")];
    const now = railItems(steps).flatMap((i) => (i.kind === "step" && i.isNow ? [i.step.id] : []));
    expect(now).toEqual(["c"]);
    expect(isWaitingOnYou(steps)).toBe(true);
    expect(isWaitingOnYou([tool("a", "done", "A")])).toBe(false);
  });
});

describe("currentStepLabels", () => {
  const run = { ...baseRun, id: "r1", threadId: "t1", status: "running" } as Run;
  const call = (id: string, status: ToolCall["status"], startedAt: string, display?: string) =>
    ({
      ...baseCall,
      id,
      runId: "r1",
      status,
      startedAt,
      target: display === undefined ? null : { kind: "file", value: "/x", display },
    }) as ToolCall;

  it("names the latest running call per thread and ignores finished runs and calls", () => {
    const labels = currentStepLabels(
      { r1: run, r2: { ...run, id: "r2", threadId: "t2", status: "done" } as Run },
      {
        a: call("a", "running", "2026-11-19T09:00:00Z", "Q3 notes.pdf"),
        b: call("b", "ok", "2026-11-19T09:05:00Z", "later but done"),
        c: { ...call("c", "running", "2026-11-19T09:06:00Z"), runId: "r2" },
      },
    );
    expect(labels).toEqual({ t1: "Q3 notes.pdf" });
  });
});

describe("RunStepLog rail", () => {
  const run = {
    ...baseRun,
    id: "run_1",
    status: "running",
    startedAt: new Date(NOW - 120_000).toISOString(),
  } as Run;
  const active = { id: run.id, startedAt: run.startedAt };

  function renderRail(steps: RunStep[]) {
    return render(
      <StoryWorld>
        <RunStepLog persona="Wren" run={active} steps={steps} now={NOW} />
      </StoryWorld>,
    );
  }

  it("marks the current step with a label and live elapsed time, and settles finished ones", () => {
    renderRail([
      tool("a", "done", "Read Q3 notes.pdf", NOW - 50_000, NOW - 44_000),
      tool("b", "running", "Searching the calendar", NOW - 7_000),
    ]);
    const log = screen.getByTestId("run-step-log");
    const done = log.querySelector('li[data-state="done"]') as HTMLElement;
    const current = log.querySelector('li[data-state="current"]') as HTMLElement;
    expect(within(done).getByText("Read Q3 notes.pdf")).toBeTruthy();
    expect(within(done).getByText("6 s")).toBeTruthy();
    expect(within(current).getByText("Searching the calendar")).toBeTruthy();
    expect(within(current).getByText("0:07")).toBeTruthy();
    expect(within(current).getByTestId("rail-halo")).toBeTruthy();
    expect(within(done).queryByTestId("rail-halo")).toBeNull();
    expect(current.getAttribute("data-now")).toBe("true");
    expect(log.getAttribute("data-waiting")).toBeNull();
  });

  it("marks a step waiting on the owner with one amber dot, no chip", () => {
    renderRail([
      tool("a", "done", "Drafted the email", NOW - 50_000, NOW - 40_000),
      {
        kind: "question",
        id: "q",
        at: NOW - 12_000,
        status: "waiting",
        label: "Asked: Which day?",
      },
    ]);
    const log = screen.getByTestId("run-step-log");
    const waiting = log.querySelector('li[data-state="waiting"]') as HTMLElement;
    expect(within(waiting).queryByText("Needs you")).toBeNull();
    expect(waiting.className).not.toContain("bg-approval-surface");
    expect(within(waiting).getByText("0:12")).toBeTruthy();
    expect(log.getAttribute("data-waiting")).toBe("true");
    expect(screen.getByTestId("chat-working").textContent).toBe("Wren is waiting for you");
    expect(log.querySelector('li[data-state="done"]')).not.toBeNull();
  });

  it("folds earlier steps and opens them on request", async () => {
    renderRail([
      ...Array.from({ length: 5 }, (_, i) =>
        tool(`d${i}`, "done", `Step ${i}`, NOW - 100_000 + i * 1000, NOW - 99_000 + i * 1000),
      ),
      tool("now", "running", "Working on it", NOW - 2_000),
    ]);
    const log = screen.getByTestId("run-step-log");
    expect(log.querySelectorAll("li")).toHaveLength(4);
    await userEvent.click(within(log).getByRole("button", { name: "3 earlier steps done" }));
    expect(log.querySelectorAll("li")).toHaveLength(6);
  });
});
