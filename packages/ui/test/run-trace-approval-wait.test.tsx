import type { Message } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatThread } from "../src/chat/Thread.tsx";
import { type createFixtureWorld, IDS } from "../src/fixtures/index.ts";
import { runTraceWorld, TRACE_IDS } from "../src/fixtures/runs.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

class InView {
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", InView));
afterEach(() => vi.unstubAllGlobals());

type World = ReturnType<typeof createFixtureWorld>;
const R = TRACE_IDS.runs;
const T = IDS.threads.lisbon;
const NOW = Date.parse("2026-10-18T09:21:00Z");

/** The `Chat/Run steps → ApprovalWait` story: Lisbon's run is blocked on step 6, the approval. */
function approvalWaitWorld(w: World) {
  const trace = runTraceWorld();
  w.runs = [
    ...w.runs.map((r) => (r.threadId === T ? { ...r, status: "done" as const } : r)),
    ...trace.runs.map((r) =>
      r.id === R.done
        ? { ...r, threadId: T, kind: "chat" as const, status: "running" as const, endedAt: null }
        : r,
    ),
  ];
  w.runSteps = trace.runSteps
    .filter((s) => s.runId !== R.done || s.seq <= 6)
    .map((s) =>
      s.runId === R.done && s.seq === 6 ? { ...s, status: "waiting" as const, endedAt: null } : s,
    );
  w.runFrames = trace.runFrames;
  w.threads = w.threads.map((th) =>
    th.thread.id === T ? { ...th, thread: { ...th.thread, activeWriterRunId: R.done } } : th,
  );
  const reply: Message = {
    id: "msg_story_wait",
    threadId: T,
    seq: 990,
    role: "agent",
    blocks: [{ type: "text", md: "On it." }],
    providerNative: null,
    provenance: "agent",
    replyToMessageId: null,
    channelRef: null,
    runId: R.done,
    createdAt: new Date(NOW - 60_000).toISOString(),
  };
  w.messages.push(reply);
}

describe("ApprovalWait: the run blocked on the owner", () => {
  it("shows the waiting step with one amber dot; the card is the only Needs-you element", async () => {
    render(
      <StoryWorld edit={approvalWaitWorld}>
        <div style={{ height: 900 }}>
          <ChatThread threadId={T} now={NOW} />
        </div>
      </StoryWorld>,
    );
    const trace = await screen.findByTestId("run-trace");
    const row = (await within(trace).findByText(/approve saving to Notion/)).closest("li");
    expect(row?.getAttribute("data-rail")).toBe("waiting");
    // One amber dot on the step: no chip, no amber row.
    expect(row?.className).not.toContain("bg-approval-surface");
    expect(within(row as HTMLElement).queryByText("Needs you")).toBeNull();
    expect(within(row as HTMLElement).getByText("0:07")).toBeTruthy();
    const log = screen.getByRole("log", { name: "Conversation" });
    // The transcript says nothing more: no chip, no "Waiting for your approval" pointer, no
    // arrow button. The approval card in the dock above the composer is the one announcement.
    expect(within(log).queryByText("Needs you")).toBeNull();
    expect(within(log).queryByText("Waiting for your approval")).toBeNull();
    expect(within(log).queryByRole("button", { name: /Review the approval/ })).toBeNull();
    expect(screen.queryAllByText("Needs you")).toEqual([]);
    const dock = await screen.findByTestId("approval-dock");
    expect(within(dock).getAllByRole("button", { name: "Allow" }).length).toBeGreaterThan(0);
  });
});
