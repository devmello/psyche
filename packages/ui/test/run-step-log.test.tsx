import type { Message, Run, ToolCall } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RunStepLog, runSteps, STALL_MS, VISIBLE_STEPS } from "../src/chat/RunStepLog.tsx";
import { ChatThread } from "../src/chat/Thread.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, IDS } from "../src/fixtures/index.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

const T = IDS.threads.main;
const NOW = Date.parse("2026-10-26T10:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const world = createFixtureWorld();
const baseRun = world.runs[0] as Run;
const baseCall = world.toolCalls[0] as ToolCall;

const run: Run = {
  ...baseRun,
  id: "run_623",
  threadId: T,
  status: "running",
  startedAt: iso(60_000),
  endedAt: null,
  error: null,
};

function call(id: string, status: ToolCall["status"], startedAgo: number, endedAgo: number | null) {
  return {
    ...baseCall,
    id,
    runId: run.id,
    tool: "web.fetch",
    target: null,
    status,
    startedAt: iso(startedAgo),
    endedAt: endedAgo === null ? null : iso(endedAgo),
  } satisfies ToolCall;
}

function agentMessage(id: string, seq: number, msAgo: number, blocks: Message["blocks"]): Message {
  return {
    id,
    threadId: T,
    seq,
    role: "agent",
    blocks,
    providerNative: null,
    provenance: "agent",
    replyToMessageId: null,
    channelRef: null,
    runId: run.id,
    createdAt: iso(msAgo),
  };
}

describe("run steps (#623)", () => {
  it("orders tool calls (ok, failed, pending) by time and ends with the reply being written", () => {
    const steps = runSteps({
      run,
      threadId: T,
      messages: [agentMessage("m1", 900, 55_000, [{ type: "text", md: "Looking it up." }])],
      toolCalls: {
        a: call("a", "ok", 50_000, 48_000),
        b: call("b", "failed", 40_000, 39_000),
        c: call("c", "pending", 30_000, null),
      },
      approvals: {},
      questions: {},
      index: null,
      streamingText: "Node.js 26 is",
    });
    // Committed text is not repeated (the transcript shows it); the stream is one "Writing" step.
    expect(steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tool:done",
      "tool:failed",
      "tool:waiting",
      "text:running",
    ]);
    expect(steps.at(-1)?.label).toBe("Writing the reply…");
  });

  it("shows the last five, opens the rest, keeps failures red and marks the current step", async () => {
    const steps = runSteps({
      run,
      threadId: T,
      messages: [],
      toolCalls: Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => {
          const status = i === 3 ? "failed" : i === 6 ? "running" : "ok";
          const c = call(`t${i}`, status, 50_000 - i * 5_000, i === 6 ? null : 49_000 - i * 5_000);
          return [c.id, c];
        }),
      ),
      approvals: {},
      questions: {},
      index: null,
    });
    render(
      <StoryWorld>
        <RunStepLog persona="Wren" run={run} steps={steps} now={NOW - 15_000} />
      </StoryWorld>,
    );
    const log = screen.getByTestId("run-step-log");
    expect(log.querySelectorAll("li")).toHaveLength(VISIBLE_STEPS);
    await userEvent.click(within(log).getByRole("button", { name: "Show all (7)" }));
    expect(log.querySelectorAll("li")).toHaveLength(7);
    const failed = log.querySelector('li[data-status="failed"] span');
    expect(failed?.className).toContain("text-danger-text");
    expect(log.querySelector('li[data-status="running"]')).not.toBeNull();
    expect(screen.getByTestId("chat-working").textContent).toBe("Wren is working…");
    expect(log.getAttribute("data-stalled")).toBeNull();
  });

  it("says when nothing has happened for 30 s, so a freeze is visible", () => {
    const steps = runSteps({
      run,
      threadId: T,
      messages: [],
      toolCalls: { a: call("a", "running", 50_000, null) },
      approvals: {},
      questions: {},
      index: null,
    });
    render(
      <StoryWorld>
        <RunStepLog persona="Wren" run={run} steps={steps} now={NOW - 50_000 + STALL_MS + 12_000} />
      </StoryWorld>,
    );
    expect(screen.getByTestId("run-step-log").getAttribute("data-stalled")).toBe("true");
    expect(screen.getByTestId("chat-working").textContent).toBe("No response for 42 s");
  });
});

describe("the step log in the thread (#623)", () => {
  it("holds the active run's calls once, then collapses into the transcript's grouped rows", async () => {
    const ref: { gateway?: MockGateway } = {};
    render(
      <StoryWorld
        onGateway={(g) => {
          ref.gateway = g;
        }}
        edit={(w) => {
          w.runs = w.runs.map((r) => (r.threadId === T ? { ...r, status: "done" as const } : r));
          w.runs.push(run);
          // A thread loaded mid-run knows its run by the transcript writer it holds.
          w.threads = w.threads.map((th) =>
            th.thread.id === T
              ? { ...th, thread: { ...th.thread, activeWriterRunId: run.id } }
              : th,
          );
          w.toolCalls.push(
            call("tc_1", "ok", 50_000, 49_000),
            call("tc_2", "running", 20_000, null),
          );
          w.messages.push(
            agentMessage("m623", 950, 45_000, [
              { type: "text", md: "Checking the release notes." },
              {
                type: "tool_call",
                toolCallId: "tc_1",
                tool: "web.fetch",
                status: "ok",
                level1: "Read nodejs.org",
              },
              {
                type: "tool_call",
                toolCallId: "tc_2",
                tool: "web.fetch",
                status: "running",
                level1: "Reading the changelog",
              },
            ]),
          );
        }}
      >
        <div style={{ height: 900 }}>
          <ChatThread threadId={T} now={NOW - 10_000} />
        </div>
      </StoryWorld>,
    );
    const steps = await screen.findByTestId("run-step-log");
    await within(steps).findByText("Reading the changelog");
    expect(within(steps).getByText("Read nodejs.org")).toBeTruthy();
    // While the run works its calls live in the log only: no grouped row in the transcript.
    const log = screen.getByRole("log", { name: "Conversation" });
    expect(within(log).queryByRole("button", { name: /2 actions · web/ })).toBeNull();
    expect(within(log).getAllByText("Read nodejs.org")).toHaveLength(1);

    const gateway = ref.gateway;
    if (gateway === undefined) throw new Error("gateway");
    act(() => gateway.setRun({ ...run, status: "done", endedAt: iso(5_000) }));
    await waitFor(() => expect(screen.queryByTestId("run-step-log")).toBeNull());
    // Collapsed: the same calls as one grouped row, which expands to the same steps.
    expect(await within(log).findByRole("button", { name: /2 actions · web/ })).toBeTruthy();
  });
});
