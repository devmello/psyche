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
  it("shows the waiting step as the amber Needs-you row with its wait time", async () => {
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
    expect(row?.className).toContain("bg-approval-surface");
    expect(within(row as HTMLElement).getByText("Needs you")).toBeTruthy();
    expect(within(trace).getAllByText("Needs you").length).toBeGreaterThan(0);
    // Nothing blocked on the owner shows as a plain grey clock anywhere in the thread: the
    // transcript's pointer, tool rows and group rows carry the same amber row and tag.
    // (A paused task card is its own surface with Resume and Cancel; it is left out here.)
    const plain = Array.from(document.querySelectorAll('[data-status="waiting"]')).filter(
      (el) =>
        el.closest(".bg-approval-surface") === null &&
        el.closest('[data-testid="run-trace"], [data-disclosure], [data-waiting]') !== null,
    );
    expect(plain.map((el) => el.parentElement?.textContent)).toEqual([]);
    // The transcript's "Waiting for your approval" pointers (one per pending approval).
    const pointers = screen
      .getAllByText("Waiting for your approval")
      .map((el) => el.closest("button") as HTMLElement);
    expect(pointers.length).toBeGreaterThan(0);
    for (const pointer of pointers) {
      expect(pointer.className).toContain("bg-approval-surface");
      expect(within(pointer).getByText("Needs you")).toBeTruthy();
    }
  });
});
