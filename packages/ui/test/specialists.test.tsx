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
import { headline, jobLine, preflightLabel } from "../src/specialists/model.ts";
import { usageLine } from "../src/specialists/ResultCard.tsx";
import { SpecialistSpawns } from "../src/specialists/SpawnLine.tsx";
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

  it("words the runtime's pre-flight in the owner's language, with its estimate", () => {
    expect(preflightLabel({ kind: "plan_exit", label: "x" })).toBe(
      "Will show you a plan to approve first",
    );
    expect(preflightLabel({ kind: "new_origin", label: "x", estimate: 5 })).toBe(
      "Will ask before opening new sites (about 5)",
    );
    // A kind the catalogue doesn't know keeps the runtime's words.
    expect(
      preflightLabel({ kind: "computer_action", label: "Will ask before using your Mac" }),
    ).toBe("Will ask before using your Mac");
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
    // The job's own pre-flight, from the spawn.
    expect(working.textContent).toContain("Will ask before opening new sites (about 5)");
    await userEvent.click(within(working).getByRole("button", { name: /started/ }));
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

describe("the owner's controls on a running job (specialists §4.7)", () => {
  function renderLine() {
    const ref: { gateway?: MockGateway } = {};
    render(
      <StoryWorld
        edit={(w) => void withSpecialists(w)}
        onGateway={(g) => {
          ref.gateway = g;
        }}
      >
        <SpecialistSpawns jobs={[job(T.working)]} />
      </StoryWorld>,
    );
    return ref;
  }
  const calls = (g: MockGateway | undefined, method: string) =>
    (g?.calls ?? []).filter((c) => c.method === method);

  it("steers with the text the owner typed", async () => {
    const ref = renderLine();
    const line = (await screen.findAllByTestId("specialist-spawn"))[0] as HTMLElement;
    await userEvent.click(within(line).getByRole("button", { name: /Tell the researcher/ }));
    await userEvent.type(await screen.findByPlaceholderText("Tell the researcher…"), "Skip fund C");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls(ref.gateway, "tasks.steer")).toHaveLength(1));
    expect(calls(ref.gateway, "tasks.steer")[0]?.params).toMatchObject({
      taskId: T.working,
      text: "Skip fund C",
    });
  });

  it("asks before stopping, and before giving it more, then calls the Gateway", async () => {
    const ref = renderLine();
    const line = (await screen.findAllByTestId("specialist-spawn"))[0] as HTMLElement;
    const menu = () => within(line).getByRole("button", { name: /More for/ });
    await userEvent.click(menu());
    await userEvent.click(await screen.findByRole("menuitem", { name: "Stop…" }));
    expect(calls(ref.gateway, "tasks.cancel")).toHaveLength(0);
    await userEvent.click(await screen.findByRole("button", { name: "Stop it" }));
    await waitFor(() => expect(calls(ref.gateway, "tasks.cancel")).toHaveLength(1));

    await userEvent.click(menu());
    await userEvent.click(await screen.findByRole("menuitem", { name: "Give it more…" }));
    expect(await screen.findByTestId("give-more-lines")).toBeTruthy();
    expect(calls(ref.gateway, "tasks.update")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Give it more" }));
    await waitFor(() => expect(calls(ref.gateway, "tasks.update")).toHaveLength(1));
    expect(calls(ref.gateway, "tasks.update")[0]?.params).toMatchObject({
      taskId: T.working,
      budget: { tokens: expect.any(Number) },
    });
  });

  it("offers nothing once the job has ended", async () => {
    render(
      <StoryWorld edit={(w) => void withSpecialists(w)}>
        <SpecialistSpawns jobs={[job(T.done)]} />
      </StoryWorld>,
    );
    await screen.findByTestId("specialist-spawn");
    expect(screen.queryByTestId("specialist-controls")).toBeNull();
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
