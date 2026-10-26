import type { SpecialistJob } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatThread } from "../src/chat/Thread.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import {
  type createFixtureWorld,
  DONE_RESULT,
  FIXTURE_NOW,
  IDS,
  SPECIALIST_IDS,
  specialistJobs,
  specialistRoles,
  withSpecialists,
} from "../src/fixtures/index.ts";
import { FeedScreen } from "../src/screens/feed/FeedScreen.tsx";
import { InboxScreen } from "../src/screens/inbox/InboxScreen.tsx";
import { headline, jobLine, preflightHints, preflightLabel } from "../src/specialists/model.ts";
import { usageLine } from "../src/specialists/ResultCard.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const NOW = Date.parse(FIXTURE_NOW);
const T = SPECIALIST_IDS.tasks;
const roles = specialistRoles();
const kind = (role: string) => roles.find((r) => r.role === role)?.result;

function job(taskId: string): SpecialistJob {
  const j = specialistJobs().find((x) => x.taskId === taskId);
  if (j === undefined) throw new Error(taskId);
  return j;
}

type World = ReturnType<typeof createFixtureWorld>;

describe("specialist words (specialists §6.2)", () => {
  it("writes the Inbox row's second line for every status", () => {
    const line = (id: string) => jobLine(job(id), kind(job(id).role));
    expect(line(T.done)).toBe("Done · 4 findings · $0.84 · 22 min");
    expect(line(T.partial)).toBe("Partial · token budget");
    expect(line(T.failed)).toBe("Failed · 6 min");
    expect(line(T.cancelled)).toBe("Cancelled · 3 min");
    expect(line(T.needsYou)).toBe("Needs you · Waiting for your approval");
    expect(line(T.working)).toBe("Working · Reading the fee tables");
    expect(line(T.queued)).toBe("Queued · 2nd · starts when a slot frees");
  });

  it("says how each job ended in Psyche's voice, and 'nothing was sent' only when true", () => {
    expect(headline(job(T.done), "Researcher")).toBe(
      "Researcher finished Apartments near the office.",
    );
    expect(headline(job(T.partial), "Shopper")).toBe(
      "Stopped at its token budget. See what's missing.",
    );
    expect(headline(job(T.failed), "Coder")).toBe(
      "Coder couldn't finish Fix the flaky sidebar test. Nothing was sent or bought.",
    );
    const failedWithReceipts = job(T.failed);
    failedWithReceipts.result = { ...DONE_RESULT, outcome: "failed" };
    expect(headline(failedWithReceipts, "Coder")).toBe(
      "Coder couldn't finish Fix the flaky sidebar test.",
    );
    expect(headline(job(T.cancelled), "Organizer")).toBe(
      "Stopped. It had 1 receipt before you stopped it.",
    );
    expect(usageLine(job(T.done))).toBe(
      "182k of 400k tokens · $0.84 of $2.00 · 22 min of 30 min · 31 steps",
    );
  });

  it("builds the pre-flight from the role: plan first, and no new-site asks in auto", () => {
    const shopper = roles.find((r) => r.role === "shopper");
    if (shopper === undefined) throw new Error("shopper");
    expect(preflightHints(shopper, "balanced").map(preflightLabel)).toEqual([
      "Will ask before opening new sites",
      "Will ask before submitting forms",
      "Will show you a plan to approve first",
    ]);
    expect(preflightHints(shopper, "auto").map((h) => h.kind)).not.toContain("new_origin");
    expect(preflightLabel({ kind: "new_origin", label: "x", estimate: 5 })).toBe(
      "Will ask before opening new sites (about 5)",
    );
  });
});

function renderInbox(slots: {
  navigate?: (r: string) => void;
  prefillComposer?: (t: string) => void;
}) {
  const ref: { gateway?: MockGateway } = {};
  render(
    <StoryWorld
      edit={(w) => void withSpecialists(w, { notifications: true })}
      onGateway={(g) => {
        ref.gateway = g;
      }}
      slots={slots}
    >
      <InboxScreen now={NOW} />
    </StoryWorld>,
  );
  return ref;
}

describe("the result card in the Inbox (specialists §6.2)", () => {
  it("opens a done result in place: findings, receipts, check, usage, taint, follow-ups", async () => {
    const navigate = vi.fn();
    const prefillComposer = vi.fn();
    renderInbox({ navigate, prefillComposer });
    const row = (await screen.findByText("Apartments near the office")).closest("article");
    if (row === null) throw new Error("row");
    expect(within(row).getByText("Done · 4 findings · $0.84 · 22 min")).toBeTruthy();
    await userEvent.click(within(row).getByRole("button", { name: "Open" }));
    const card = within(row).getByTestId("specialist-result");
    expect(within(card).getByText("Researcher finished Apartments near the office.")).toBeTruthy();
    // Three findings until "Show all".
    expect(within(card).queryByText("Rua do Século 20 · €1,600")).toBeNull();
    await userEvent.click(within(card).getByRole("button", { name: "Show all 4" }));
    expect(within(card).getByText("Rua do Século 20 · €1,600")).toBeTruthy();
    expect(within(card).getByText("Checked: Every listing has a source and a price.")).toBeTruthy();
    expect(within(card).getByText(/182k of 400k tokens/)).toBeTruthy();
    expect(within(card).getByText(/Treat its claims as unverified/)).toBeTruthy();
    const did = within(card).getByRole("heading", { name: "What it did" })
      .parentElement as HTMLElement;
    await waitFor(() => expect(within(did).getAllByRole("listitem")).toHaveLength(2));
    await userEvent.click(within(card).getByRole("button", { name: "Book viewings" }));
    expect(navigate).toHaveBeenCalledWith(`/chat/${SPECIALIST_IDS.parent.threadId}`);
    expect(prefillComposer).toHaveBeenCalledWith(
      "Book viewings for the three flats the researcher found.",
    );
    await userEvent.click(within(card).getByRole("button", { name: "Timeline" }));
    expect(navigate).toHaveBeenCalledWith(`/agent/activity/run/${SPECIALIST_IDS.runs.done}`);
  });

  it("retries a failed job (tasks.retry) and says nothing was sent", async () => {
    const ref = renderInbox({});
    const row = (await screen.findByText("Fix the flaky sidebar test")).closest("article");
    if (row === null) throw new Error("row");
    await userEvent.click(within(row).getByRole("button", { name: "Open" }));
    expect(within(row).getByText(/Nothing was sent or bought\./)).toBeTruthy();
    expect(
      within(row).getByText("Run pnpm install in ~/Projects/psyche, then retry."),
    ).toBeTruthy();
    const call = vi.spyOn(ref.gateway as MockGateway, "request");
    await userEvent.click(within(row).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("tasks.retry", { taskId: T.failed }, expect.anything()),
    );
    await waitFor(() => expect(row.textContent).toContain("Queued"));
  });
});

/** The main thread's first run started two jobs. */
function spawned(w: World): void {
  w.specialistJobs = (w.specialistJobs ?? [])
    .filter((j) => j.taskId === T.working || j.taskId === T.queued)
    .map((j) => ({ ...j, parentThreadId: IDS.threads.main, parentRunId: IDS.runs.main }));
}

describe("the parent thread's line (specialists §6.1)", () => {
  it("shows each job after its run with the pre-flight, and follows it to its result", async () => {
    const navigate = vi.fn();
    const ref: { gateway?: MockGateway } = {};
    render(
      <StoryWorld
        edit={spawned}
        onGateway={(g) => {
          ref.gateway = g;
        }}
        slots={{ navigate }}
      >
        <div style={{ height: 900 }}>
          <ChatThread threadId={IDS.threads.main} now={NOW} />
        </div>
      </StoryWorld>,
    );
    // Once the messages load, the lines sit after the run that started them.
    await waitFor(() =>
      expect(document.getElementById(`message-${IDS.messages.mainAgent}`)).toBeTruthy(),
    );
    const list = screen.getByTestId("specialist-spawns");
    const after = (a: Element | null, b: Element | null) =>
      a !== null &&
      b !== null &&
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) > 0;
    // After the run's reply, before the owner's next message.
    expect(after(document.getElementById(`message-${IDS.messages.mainAgent}`), list)).toBe(true);
    expect(after(list, document.getElementById(`message-${IDS.messages.mainUserTax}`))).toBe(true);
    const lines = screen.getAllByTestId("specialist-spawn");
    expect(lines.map((l) => l.getAttribute("data-status"))).toEqual(["working", "queued"]);
    const working = lines[0] as HTMLElement;
    expect(working.textContent).toContain(
      "Started the researcher · Compare the three pension funds",
    );
    expect(working.textContent).toContain("Will ask before opening new sites");
    await userEvent.click(within(working).getByRole("button"));
    expect(navigate).toHaveBeenCalledWith(`/agent/activity/run/${SPECIALIST_IDS.runs.working}`);

    // A new job arrives live, then the working one delivers.
    const gateway = ref.gateway as MockGateway;
    const fresh: SpecialistJob = {
      ...job(T.queued),
      taskId: "task_spec_new",
      title: "Find a plumber",
      parentThreadId: IDS.threads.main,
      parentRunId: IDS.runs.main,
      createdAt: "2026-10-18T10:11:00Z",
    };
    act(() => gateway.setSpecialistJob(fresh));
    await waitFor(() => expect(screen.getAllByTestId("specialist-spawn")).toHaveLength(3));
    act(() =>
      gateway.setSpecialistJob({
        ...job(T.working),
        parentThreadId: IDS.threads.main,
        parentRunId: IDS.runs.main,
        result: { ...DONE_RESULT, findings: DONE_RESULT.findings.slice(0, 2) },
      }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("specialist-spawn")[0]?.getAttribute("data-status")).toBe(
        "done",
      ),
    );
    const done = screen.getAllByTestId("specialist-spawn")[0] as HTMLElement;
    expect(done.textContent).toContain("Done · 2 findings");
    // The pre-flight is for the start; a finished job doesn't repeat it.
    expect(done.textContent).not.toContain("Will ask before");
  });
});

describe("specialist results in the Feed (specialists §6.2)", () => {
  const feed = (on: boolean) =>
    render(
      <StoryWorld
        edit={(w) => {
          withSpecialists(w);
          if (on) w.settings = { ...w.settings, "specialists.showInFeed": true };
        }}
      >
        <FeedScreen now={NOW} />
      </StoryWorld>,
    );

  it("stays out of the Feed unless the owner turned it on", async () => {
    feed(false);
    await screen.findByRole("heading", { name: "Feed" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.queryByText("From your specialists")).toBeNull();
  });

  it("shows the last day's results when it's on", async () => {
    feed(true);
    const section = (await screen.findByText("From your specialists")).closest("section");
    if (section === null) throw new Error("section");
    expect(within(section).getByText("Apartments near the office")).toBeTruthy();
    expect(within(section).getByText("Noise-cancelling headphones under $300")).toBeTruthy();
    // The cancelled job is from five hours ago, still today; the queue never shows.
    expect(within(section).queryByText("Birthday gift ideas for Sam")).toBeNull();
  });
});
