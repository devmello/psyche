import type { ThreadListEntry } from "@psyche/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AutomationChat,
  automationOfThread,
  resultLine,
  runTone,
} from "../src/chat/AutomationChat.tsx";
import { INITIAL_STATE } from "../src/data/state.ts";
import { withAutomationRun } from "../src/data/store.ts";
import { IDS } from "../src/fixtures/index.ts";
import { applyRunTrace, TRACE_IDS } from "../src/fixtures/runs.ts";
import { ThreadRow } from "../src/shell/ThreadList.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

const A = IDS.automations.morningBrief;
const R = TRACE_IDS.runs;

describe("automationOfThread", () => {
  it("names the automation of its chat and of a run's work thread", () => {
    expect(automationOfThread({ kind: "automation", sessionKey: "automation:aut_1" })).toEqual({
      automationId: "aut_1",
      runThread: false,
    });
    expect(automationOfThread({ kind: "automation", sessionKey: "cron:aut_1:run_9" })).toEqual({
      automationId: "aut_1",
      runThread: true,
    });
    expect(automationOfThread({ kind: "automation", sessionKey: "named:research" })).toBeNull();
    expect(automationOfThread({ kind: "side", sessionKey: "automation:aut_1" })).toBeNull();
    expect(automationOfThread(undefined)).toBeNull();
  });
});

describe("run status", () => {
  it("reads amber when a running run waits for the owner", () => {
    expect(runTone("running", "awaiting_approval")).toBe("needs-you");
    expect(runTone("running", "awaiting_input")).toBe("needs-you");
    expect(runTone("running", "running")).toBe("running");
    expect(runTone("failed")).toBe("failed");
    expect(runTone("no_reply")).toBe("done");
  });

  it("keeps the first line of a result as plain text", () => {
    expect(resultLine("**3 meetings today.**\n\n- more")).toBe("3 meetings today.");
    expect(resultLine(null)).toBe("");
  });
});

describe("AutomationChat", () => {
  const world = (w: Parameters<typeof applyRunTrace>[0] & { automationRuns?: unknown }) => {
    applyRunTrace(w);
    const runs = (w as { automationRuns: { status: string; summary: string | null }[] })
      .automationRuns;
    // Newest first: one failed run, one still going.
    if (runs[0]) Object.assign(runs[0], { status: "running", endedAt: null, summary: null });
    if (runs[1]) Object.assign(runs[1], { status: "failed", summary: "Mail was unreachable" });
  };

  it("lists each run folded, with its status in words, and opens one to its steps", async () => {
    const navigate = vi.fn();
    render(
      <StoryWorld edit={world as never}>
        <UiSlotsProvider value={{ navigate }}>
          <AutomationChat automationId={A} title="Morning brief" timezone="UTC" now={STORY_NOW} />
        </UiSlotsProvider>
      </StoryWorld>,
    );
    const blocks = await screen.findAllByTestId("automation-run");
    expect(blocks.length).toBeGreaterThan(5);
    const failed = blocks.find((b) => within(b).queryByText("Failed") !== null);
    expect(failed).toBeDefined();
    expect(within(failed as HTMLElement).getByText("Mail was unreachable")).toBeTruthy();
    expect(failed?.getAttribute("data-open")).toBe("false");
    // The run still going is open, with its trace. It opens on a later render than the list
    // appears, so wait for it (it raced on a loaded CI runner, 2026-11-03).
    await waitFor(() =>
      expect(screen.getAllByTestId("automation-run")[0]?.getAttribute("data-open")).toBe("true"),
    );
    // A finished run opens to its steps and result on a click.
    const done = blocks.find((b) => b.getAttribute("data-open") === "false" && b !== failed);
    fireEvent.click(within(done as HTMLElement).getAllByRole("button")[0] as HTMLElement);
    await waitFor(() => expect(done?.getAttribute("data-open")).toBe("true"));
    expect(await within(done as HTMLElement).findByText("Read your calendar")).toBeTruthy();
    fireEvent.click(within(done as HTMLElement).getByRole("button", { name: /Timeline/ }));
    expect(navigate).toHaveBeenCalledWith(
      expect.stringMatching(/^\/agent\/activity\/run\/run_trace_brief_/),
    );
  });

  it("opens the run whose work thread a link names", async () => {
    let target = "";
    render(
      <StoryWorld
        edit={
          ((w: Parameters<typeof applyRunTrace>[0]) => {
            world(w);
            target =
              (w as unknown as { automationRuns: { id: string; threadId: string }[] })
                .automationRuns[3]?.id ?? "";
            const runs = (w as unknown as { automationRuns: { threadId: string | null }[] })
              .automationRuns;
            if (runs[3]) runs[3].threadId = "thr_run_work";
          }) as never
        }
      >
        <AutomationChat
          automationId={A}
          title="Morning brief"
          timezone="UTC"
          now={STORY_NOW}
          focusThreadId="thr_run_work"
        />
      </StoryWorld>,
    );
    const blocks = await screen.findAllByTestId("automation-run");
    const focused = blocks.find((b) => b.getAttribute("data-run-id") === target);
    expect(focused?.getAttribute("data-open")).toBe("true");
    expect(R.automation(1)).toBeTruthy();
  });
});

describe("an automation in the thread list", () => {
  const entry = (over: Partial<ThreadListEntry> = {}): ThreadListEntry => ({
    thread: {
      id: "thr_auto",
      kind: "automation",
      title: "Morning brief",
      titleSource: "auto",
      parentThreadId: null,
      forkedFromMessageId: null,
      sessionKey: "automation:aut_1",
      personaOverlay: null,
      permissionMode: "balanced",
      modelRef: null,
      pinned: false,
      archivedAt: null,
      expiresAt: null,
      activeWriterRunId: null,
      createdAt: "2026-11-01T07:00:00Z",
      updatedAt: "2026-11-02T07:00:00Z",
      lastMessageAt: "2026-11-02T07:00:00Z",
    },
    activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
    automation: {
      automationId: "aut_1",
      runCount: 12,
      lastRun: {
        id: "ar_1",
        status: "failed",
        startedAt: "2026-11-02T07:00:00Z",
        endedAt: "2026-11-02T07:01:00Z",
        summary: "Mail was unreachable",
      },
    },
    ...over,
  });
  const row = (e: ThreadListEntry) =>
    render(
      <StoryWorld>
        <ul>
          <ThreadRow entry={e} active={false} now={STORY_NOW} onOpen={() => {}} />
        </ul>
      </StoryWorld>,
    );

  it("shows one row with its run count and a failed dot, and the last result as its tooltip", () => {
    row(entry());
    expect(screen.getAllByTestId("thread-row")).toHaveLength(1);
    expect(screen.getByTestId("automation-runs").textContent).toContain("12 runs");
    expect(screen.getByTestId("thread-row").getAttribute("title")).toBe("Mail was unreachable");
  });

  it("shows needs-you over the count while a run waits", () => {
    row(entry({ activity: { running: 0, awaitingInput: 0, awaitingApproval: 1 } }));
    expect(screen.getByTestId("thread-status").getAttribute("data-status")).toBe("needs-you");
    expect(screen.queryByTestId("automation-runs")).toBeNull();
  });
});

describe("the chat list follows the runs", () => {
  const home = {
    thread: {
      id: "thr_auto",
      kind: "automation",
      title: "Morning brief",
      lastMessageAt: "2026-11-01T07:00:00Z",
    },
    activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
    automation: { automationId: "aut_1", runCount: 3 },
  } as unknown as ThreadListEntry;
  const state = { ...INITIAL_STATE, threads: { thr_auto: home } };
  const run = (over: Record<string, unknown>) =>
    ({
      id: "ar_9",
      automationId: "aut_1",
      startedAt: "2026-11-02T07:00:00Z",
      endedAt: null,
      status: "running",
      summary: null,
      ...over,
    }) as never;

  it("counts a run once when it starts and again never when it finishes", () => {
    const started = withAutomationRun(state, run({}), true);
    expect(started.threads.thr_auto?.automation).toMatchObject({
      runCount: 4,
      lastRun: { id: "ar_9", status: "running" },
    });
    expect(started.threads.thr_auto?.thread.lastMessageAt).toBe("2026-11-02T07:00:00Z");
    const finished = withAutomationRun(
      started,
      run({ status: "done", endedAt: "2026-11-02T07:01:00Z", summary: "Brief ready" }),
      false,
    );
    expect(finished.threads.thr_auto?.automation).toMatchObject({
      runCount: 4,
      lastRun: { status: "done", summary: "Brief ready" },
    });
  });

  it("leaves a chat of another automation, and a list without it, alone", () => {
    expect(withAutomationRun(state, run({ automationId: "aut_2" }), true)).toBe(state);
  });
});
