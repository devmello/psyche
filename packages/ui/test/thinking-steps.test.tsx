import type { Run, ToolCall } from "@psyche/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { lastActivity, runSteps } from "../src/chat/RunStepLog.tsx";
import { ChatThread } from "../src/chat/Thread.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { ReasoningStep } from "../src/data/state.ts";
import { createFixtureWorld, IDS } from "../src/fixtures/index.ts";
import { PersonaPanel } from "../src/screens/settings/PersonaSection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const T = IDS.threads.main;
const world = createFixtureWorld();
const baseRun = world.runs[0] as Run;
const baseCall = world.toolCalls[0] as ToolCall;
const NOW = Date.parse("2026-10-26T10:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const run: Run = {
  ...baseRun,
  id: "run_633",
  threadId: T,
  status: "running",
  startedAt: iso(60_000),
  endedAt: null,
  error: null,
};

function step(stepId: string, startedAgo: number, patch: Partial<ReasoningStep>): ReasoningStep {
  return {
    threadId: T,
    runId: run.id,
    stepId,
    text: "",
    summary: null,
    done: false,
    startedAt: iso(startedAgo),
    updatedAt: iso(startedAgo),
    ...patch,
  };
}

describe("thinking steps (#633)", () => {
  it("puts one Thinking step per step id in order with tool steps, done or running", () => {
    const steps = runSteps({
      run,
      threadId: T,
      messages: [],
      toolCalls: {
        tc: {
          ...baseCall,
          id: "tc",
          runId: run.id,
          tool: "web.fetch",
          target: null,
          status: "ok",
          startedAt: iso(40_000),
          endedAt: iso(39_000),
        },
      },
      approvals: {},
      questions: {},
      reasoning: {
        r1: step("r1", 50_000, { text: "The user wants the LTS.\nCheck nodejs.org.", done: true }),
        r2: step("r2", 30_000, { summary: "Comparing release lines", updatedAt: iso(5_000) }),
        other: { ...step("other", 10_000, { text: "elsewhere" }), runId: "run_other" },
      },
      index: null,
    });
    expect(steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "thinking:done",
      "tool:done",
      "thinking:running",
    ]);
    expect(steps[0]?.label).toBe("The user wants the LTS.");
    // A summary-only step shows the summary; streaming reasoning counts as activity.
    expect(steps[2]?.label).toBe("Comparing release lines");
    expect(lastActivity({ id: run.id, startedAt: run.startedAt }, steps)).toBe(NOW - 5_000);
  });

  it("streams into the step log from chat.reasoning events and is dropped when the run ends", async () => {
    const ref: { gateway?: MockGateway } = {};
    render(
      <StoryWorld
        onGateway={(g) => {
          ref.gateway = g;
        }}
        edit={(w) => {
          w.runs = w.runs.map((r) => (r.threadId === T ? { ...r, status: "done" as const } : r));
        }}
      >
        <div style={{ height: 900 }}>
          <ChatThread threadId={T} />
        </div>
      </StoryWorld>,
    );
    await screen.findByRole("log", { name: "Conversation" });
    const gateway = ref.gateway;
    if (gateway === undefined) throw new Error("gateway");
    act(() => gateway.setRun({ ...run, startedAt: new Date().toISOString() }));
    const emit = (payload: { delta?: string; summary?: string; done?: boolean }) =>
      act(() =>
        gateway.emit("chat.reasoning", { threadId: T, runId: run.id, stepId: "rs_1", ...payload }),
      );
    emit({ delta: "The owner asked for the LTS. " });
    const log = await screen.findByTestId("run-step-log");
    const thinking = () => log.querySelector<HTMLElement>('li[data-step="thinking"]');
    await waitFor(() => expect(thinking()?.getAttribute("data-status")).toBe("running"));
    expect(thinking()?.textContent).toContain("Thinking: The owner asked for the LTS.");
    // Deltas grow the same step; the first line stays the collapsed label.
    emit({ delta: "\nI'll read nodejs.org and compare the release lines." });
    expect(log.querySelectorAll('li[data-step="thinking"]')).toHaveLength(1);
    const toggle = within(thinking() as HTMLElement).getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(thinking()?.textContent).toContain("compare the release lines");
    emit({ done: true });
    await waitFor(() => expect(thinking()?.getAttribute("data-status")).toBe("done"));

    // Nothing is kept beyond the run.
    act(() => gateway.setRun({ ...run, status: "done", endedAt: new Date().toISOString() }));
    await waitFor(() => expect(screen.queryByTestId("run-step-log")).toBeNull());
    act(() => gateway.setRun({ ...run, id: "run_633b", startedAt: new Date().toISOString() }));
    const next = await screen.findByTestId("run-step-log");
    expect(next.querySelector('li[data-step="thinking"]')).toBeNull();
  });
});

describe("Settings → Persona: show thinking (#633)", () => {
  it("is one switch on agent.showReasoning, on by default", () => {
    const onChange = vi.fn();
    render(
      <StoryWorld>
        <PersonaPanel values={{}} onChange={onChange} />
      </StoryWorld>,
    );
    const toggle = screen.getByRole("switch", { name: "Show thinking while it works" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith("agent.showReasoning", false);
  });
});
