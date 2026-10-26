import type { Message, RunStep } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  buildRows,
  STALL_MS,
  stepLabel,
  summarizeRun,
  timelineRoute,
  VISIBLE_STEPS,
  visibleRows,
} from "../src/chat/steps/model.ts";
import { ChatThread } from "../src/chat/Thread.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { type createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { runTraceWorld, TRACE_IDS, traceRuns, traceSteps } from "../src/fixtures/runs.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

const R = TRACE_IDS.runs;
const NOW = Date.parse(FIXTURE_NOW);
const steps = traceSteps();
const of = (runId: string) => steps.filter((s) => s.runId === runId);
const run = (id: string) => {
  const r = traceRuns().find((x) => x.id === id);
  if (r === undefined) throw new Error(id);
  return r;
};

function tool(id: string, seq: number, patch: Partial<RunStep> = {}): RunStep {
  return {
    id,
    runId: "run_t",
    seq,
    kind: "tool",
    status: "ok",
    label: "Reading a page",
    doneLabel: "Read a page",
    target: "kayak.com",
    startedAt: "2026-10-18T10:00:00Z",
    endedAt: "2026-10-18T10:00:02Z",
    attempt: 1,
    ...patch,
  };
}

describe("step rows (run-trace §3.2)", () => {
  it("groups parallel steps, flips tense and keeps helpers on their spawn step", () => {
    const rows = buildRows(of(R.done));
    expect(rows.map((r) => r.type)).toEqual([
      "step",
      "group",
      "step",
      "step",
      "step",
      "step",
      "step",
    ]);
    const group = rows[1];
    expect(group?.type === "group" && group.steps.length).toBe(3);
    const searching = of(R.done).find((s) => s.id === "stp_trace_lisbon_02") as RunStep;
    expect(stepLabel(searching)).toBe("Searched flights");
    expect(stepLabel({ ...searching, status: "running", endedAt: null })).toBe("Searching flights");
    expect(stepLabel(of(R.done)[0] as RunStep)).toBe(
      "Thinking: Search flights, hotels and neighbourhoods at once",
    );
  });

  it("folds repeats of the same tool and outcome, never a failure", () => {
    const rows = buildRows([
      tool("a", 1),
      tool("b", 2),
      tool("c", 3),
      tool("d", 4, { status: "failed", doneLabel: "Couldn't read a page" }),
      tool("e", 5),
    ]);
    expect(rows.map((r) => (r.type === "repeat" ? `repeat×${r.steps.length}` : r.type))).toEqual([
      "repeat×3",
      "step",
      "step",
    ]);
  });

  it("shows the last five, and a failed or waiting row however early", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      tool(`s${i}`, i + 1, {
        target: `site${i}.com`,
        ...(i === 1 ? { status: "failed" as const } : {}),
        ...(i === 2 ? { kind: "approval" as const, status: "waiting" as const } : {}),
      }),
    );
    const rows = buildRows(many);
    const shown = visibleRows(rows, false);
    expect(shown).toHaveLength(VISIBLE_STEPS + 2);
    expect(shown.map((r) => r.key)).toEqual(["s1", "s2", "s4", "s5", "s6", "s7", "s8"]);
    expect(visibleRows(rows, true)).toHaveLength(9);
  });

  it("summarises side effects first, then steps; and the failed, cancelled and incognito forms", () => {
    const done = run(R.done);
    expect(
      summarizeRun(done, of(R.done), [
        { kind: "send_email", outcome: "ok" },
        { kind: "calendar_write", outcome: "ok" },
        { kind: "browser_read", outcome: "ok" },
      ]).text,
    ).toBe("Worked for 1 min 34 s · sent 1 email · added 1 event · 9 steps");
    expect(summarizeRun(run(R.failed), of(R.failed), []).text).toBe(
      "Stopped at step 2 · Reading statements failed · 1 min 45 s",
    );
    expect(summarizeRun({ ...done, status: "cancelled" }, of(R.done), []).text).toBe(
      "Stopped by you after 1 min 34 s · 9 steps",
    );
    expect(summarizeRun(done, of(R.done), [], { incognito: true }).text).toBe(
      "Not kept · incognito",
    );
    expect(timelineRoute(R.live)).toBe(`/agent/activity/run/${R.live}`);
    expect(timelineRoute(R.live, "stp_1")).toBe(`/agent/activity/run/${R.live}?step=stp_1`);
  });
});

type World = ReturnType<typeof createFixtureWorld>;

/** The dentist thread's turn is the trace's live run, with one reply message anchored to it. */
function liveWorld(w: World) {
  const trace = runTraceWorld();
  w.runs = [
    ...w.runs.map((r) =>
      r.threadId === IDS.threads.dentist ? { ...r, status: "done" as const } : r,
    ),
    ...trace.runs.map((r) => (r.id === R.live ? { ...r, kind: "chat" as const } : r)),
  ];
  w.runSteps = trace.runSteps;
  w.runFrames = trace.runFrames;
  w.threads = w.threads.map((th) =>
    th.thread.id === IDS.threads.dentist
      ? { ...th, thread: { ...th.thread, activeWriterRunId: R.live } }
      : th,
  );
  const reply: Message = {
    id: "msg_trace_reply",
    threadId: IDS.threads.dentist,
    seq: 990,
    role: "agent",
    blocks: [
      { type: "text", md: "Looking at Dr. Ortiz's calendar." },
      {
        type: "tool_call",
        toolCallId: "tc_trace_dentist",
        tool: "browser.navigate",
        status: "ok",
        level1: "Opened the booking page",
      },
    ],
    providerNative: null,
    provenance: "agent",
    replyToMessageId: null,
    channelRef: null,
    runId: R.live,
    createdAt: "2026-10-18T10:10:31Z",
  };
  w.messages.push(reply);
}

function renderLive(now: number, navigate = vi.fn()) {
  const ref: { gateway?: MockGateway } = {};
  render(
    <StoryWorld
      edit={liveWorld}
      onGateway={(g) => {
        ref.gateway = g;
      }}
      slots={{ navigate }}
    >
      <div style={{ height: 900 }}>
        <ChatThread threadId={IDS.threads.dentist} now={now} />
      </div>
    </StoryWorld>,
  );
  return ref;
}

describe("the run's steps in the chat (run-trace §3.2)", () => {
  it("shows the live run above its reply, without the transcript's tool rows", async () => {
    renderLive(NOW);
    const trace = await screen.findByTestId("run-trace");
    expect(trace.getAttribute("data-state")).toBe("live");
    await within(trace).findByText("Checking open slots");
    expect(within(trace).getByText("Working")).toBeTruthy();
    // The run's anchor: directly before the reply it belongs to.
    expect(trace.nextElementSibling?.id).toBe("message-msg_trace_reply");
    const log = screen.getByRole("log", { name: "Conversation" });
    expect(within(log).queryByText("Opened the booking page")).toBeNull();
  });

  it("says when nothing has happened for 30 s", async () => {
    const lastStep = Date.parse("2026-10-18T10:11:40Z");
    renderLive(lastStep + STALL_MS + 5_000);
    expect(await screen.findByTestId("trace-stalled")).toHaveProperty(
      "textContent",
      "No response for 35 s",
    );
  });

  it("announces step starts and outcomes, never the ticking time, and condenses in place", async () => {
    const navigate = vi.fn();
    const ref = renderLive(NOW, navigate);
    const trace = await screen.findByTestId("run-trace");
    await within(trace).findByText("Checking open slots");
    const announcer = screen.getByTestId("trace-announcer");
    expect(announcer.textContent).toBe("");
    const gateway = ref.gateway;
    if (gateway === undefined) throw new Error("gateway");
    const running = traceSteps().find((s) => s.id === "stp_trace_dentist_03") as RunStep;
    act(() => gateway.setStep({ ...running, status: "ok", endedAt: "2026-10-18T10:11:55Z" }));
    await waitFor(() => expect(announcer.textContent).toBe("Checked open slots: done"));
    act(() =>
      gateway.setStep({
        ...running,
        id: "stp_trace_dentist_04",
        seq: 4,
        label: "Holding the 2:30 slot",
        doneLabel: "Held the 2:30 slot",
        status: "running",
        startedAt: "2026-10-18T10:11:56Z",
        endedAt: null,
        progress: undefined,
      }),
    );
    await waitFor(() => expect(announcer.textContent).toBe("Holding the 2:30 slot"));

    act(() =>
      gateway.setStep({
        ...running,
        id: "stp_trace_dentist_04",
        seq: 4,
        label: "Holding the 2:30 slot",
        doneLabel: "Held the 2:30 slot",
        status: "ok",
        startedAt: "2026-10-18T10:11:56Z",
        endedAt: "2026-10-18T10:11:59Z",
        progress: undefined,
      }),
    );
    await waitFor(() => expect(announcer.textContent).toBe("Held the 2:30 slot: done"));

    // The run ends: the same anchor becomes the summary row, no jump.
    const reply = document.getElementById("message-msg_trace_reply");
    act(() =>
      gateway.setRun({
        ...run(R.live),
        kind: "chat",
        status: "done",
        endedAt: "2026-10-18T10:12:00Z",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("run-trace").getAttribute("data-state")).toBe("done"),
    );
    const summary = screen.getByTestId("run-trace");
    expect(summary.nextElementSibling).toBe(reply);
    const row = within(summary).getByTestId("run-summary");
    expect(row.textContent).toContain("Worked for 1 min 30 s");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(row);
    expect(within(summary).getByText("Held the 2:30 slot")).toBeTruthy();
    await userEvent.click(within(summary).getByRole("button", { name: /Timeline/ }));
    expect(navigate).toHaveBeenCalledWith(`/agent/activity/run/${R.live}`);
  });
});
