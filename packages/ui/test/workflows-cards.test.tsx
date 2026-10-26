import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import {
  draftView,
  type FixtureWorld,
  inboxDigest,
  meetingNotes,
  meetingPrep,
  quietDigest,
  schedulingView,
  WORKFLOW_IDS,
  withWorkflows,
  workflowLoops,
} from "../src/fixtures/index.ts";
import { FeedScreen } from "../src/screens/feed/FeedScreen.tsx";
import { DigestCard } from "../src/screens/workflows/DigestCard.tsx";
import { DraftCard } from "../src/screens/workflows/DraftCard.tsx";
import { FollowUpsCard, followUpSegment } from "../src/screens/workflows/FollowUpsCard.tsx";
import { MeetingNotesCard, offsetLabel } from "../src/screens/workflows/MeetingNotesCard.tsx";
import { MeetingPrepCard } from "../src/screens/workflows/MeetingPrepCard.tsx";
import { SchedulingCard } from "../src/screens/workflows/SchedulingCard.tsx";
import type { UiSlots } from "../src/slots.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/** Mail and meeting cards (docs/workflows/mail-and-meetings-2026.md §7.1, workstream U). */

function setup(
  ui: ReactElement,
  options: { edit?: (w: FixtureWorld) => void; slots?: UiSlots } = {},
) {
  let gateway: MockGateway | undefined;
  const user = userEvent.setup();
  render(
    <StoryWorld
      {...(options.edit ? { edit: options.edit } : {})}
      onGateway={(g) => {
        gateway = g;
      }}
      {...(options.slots ? { slots: options.slots } : {})}
    >
      {ui}
    </StoryWorld>,
  );
  const callsTo = (method: string) =>
    (gateway?.calls ?? []).filter((c) => c.method === method).map((c) => c.params);
  return { user, callsTo };
}

describe("DigestCard", () => {
  it("shows the header, the Because phrase, groups, waiting-on rows and the screen", () => {
    render(<DigestCard digest={inboxDigest()} now={STORY_NOW} />);
    const card = screen.getByRole("article", { name: "Inbox digest" });
    expect(within(card).getByText(/^Inbox · .* · 3 need you$/)).toBeTruthy();
    expect(within(card).getByText("Because: asks you a direct question")).toBeTruthy();
    expect(within(card).getByText("12 newsletters · Mark read · Move to Reading")).toBeTruthy();
    expect(within(card).getByText("Dana Ruiz · contract draft · 4 days")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(within(card).getByText("Couldn't verify the sender")).toBeTruthy();
    // Untrusted mail and a cloud model are both said on the card (§3 rules 3 and 7).
    expect(within(card).getByText("Contains text from Sam Lee")).toBeTruthy();
    expect(within(card).getByText("Cloud")).toBeTruthy();
  });

  it("offers each row's actions under ⋯ and the group's Do it", async () => {
    const onAction = vi.fn();
    const onGroup = vi.fn();
    const user = userEvent.setup();
    render(
      <DigestCard digest={inboxDigest()} now={STORY_NOW} onAction={onAction} onGroup={onGroup} />,
    );
    await user.click(
      screen.getByRole("button", { name: "More for Can we move Thursday's review?" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Propose times" }));
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ category: "needs_you" }),
      "propose_times",
    );
    const doIt = screen.getAllByRole("button", { name: "Do it" });
    // The FYI group has no batch, so only two groups offer Do it.
    expect(doIt).toHaveLength(2);
    await user.click(doIt[0] as HTMLElement);
    expect(onGroup).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: WORKFLOW_IDS.proposals.newsletters }),
    );
  });

  it("opens the batch card inline under the group row", async () => {
    const user = userEvent.setup();
    render(
      <DigestCard digest={inboxDigest()} now={STORY_NOW} renderBatch={(id) => <p>batch {id}</p>} />,
    );
    const [first] = screen.getAllByRole("button", { name: "Do it" });
    await user.click(first as HTMLElement);
    expect(screen.getByText(`batch ${WORKFLOW_IDS.proposals.newsletters}`)).toBeTruthy();
    expect(first?.getAttribute("aria-expanded")).toBe("true");
  });

  it("says when nothing needs the owner", () => {
    render(<DigestCard digest={quietDigest()} now={STORY_NOW} />);
    expect(screen.getByText("Nothing needs you. 7 messages sorted.")).toBeTruthy();
    expect(screen.queryByText(/Contains text from/)).toBeNull();
  });
});

describe("FollowUpsCard", () => {
  it("splits loops into waiting on, you owe and stale", async () => {
    const loops = workflowLoops();
    expect(loops.map((l) => followUpSegment(l, STORY_NOW))).toEqual([
      "waiting",
      "waiting",
      "owe",
      "stale",
    ]);
    const onLoop = vi.fn();
    const user = userEvent.setup();
    render(<FollowUpsCard loops={loops} now={STORY_NOW} onLoop={onLoop} />);
    expect(screen.getByText("contract draft")).toBeTruthy();
    expect(screen.queryByText("send the Q4 deck")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Stale" }));
    expect(screen.getByText("the venue quote")).toBeTruthy();
    expect(screen.getByText("Shown twice: it won't come up again.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onLoop).toHaveBeenCalledWith(loops[3], "done");
  });
});

describe("DraftCard", () => {
  it("shows three lines, the commitments and the tone chips; Send arms after 400 ms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onSend = vi.fn();
    const onTone = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<DraftCard draft={draftView()} focused onSend={onSend} onTone={onTone} />);
    expect(screen.queryByText(/Thanks,/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the whole draft" }));
    expect(screen.getByText(/Thanks,/)).toBeTruthy();
    expect(screen.getByText(/Check before sending/)).toBeTruthy();
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    vi.advanceTimersByTime(400);
    await waitFor(() => expect(send.disabled).toBe(false));
    await user.click(send);
    expect(onSend).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Warmer" }));
    expect(onTone).toHaveBeenCalledWith("warmer");
    vi.useRealTimers();
  });
});

describe("SchedulingCard", () => {
  it("lists slots in both time zones and holds the picked ones", async () => {
    const onHold = vi.fn();
    const user = userEvent.setup();
    render(<SchedulingCard view={schedulingView()} onHold={onHold} onDraftReply={() => {}} />);
    expect(screen.getAllByText(/for them$/)).toHaveLength(3);
    const boxes = screen.getAllByRole("checkbox");
    await user.click(boxes[1] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Hold these times" }));
    expect(onHold).toHaveBeenCalledWith([0, 2]);
  });

  it("confirms the picked slot as one batch", () => {
    render(
      <SchedulingCard
        view={{ ...schedulingView(), state: "picked", picked: 0, holds: 2 }}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Create event · Release 2 holds" })).toBeTruthy();
  });
});

describe("MeetingPrepCard", () => {
  it("shows the sections with sources and Join, and collapses once started", async () => {
    const onJoin = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <MeetingPrepCard prep={meetingPrep()} now={STORY_NOW} onJoin={onJoin} />,
    );
    expect(screen.getByRole("heading", { name: "Acme quarterly review" })).toBeTruthy();
    expect(screen.getByText("You owe: send the Q4 deck")).toBeTruthy();
    expect(screen.getByText("Suggested agenda")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(onJoin).toHaveBeenCalledWith("https://meet.example/acme-review");
    unmount();
    render(<MeetingPrepCard prep={meetingPrep()} now={STORY_NOW + 3_600_000} />);
    expect(screen.getByText(/^Acme quarterly review · started /)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show prep" }));
    expect(screen.getByText("Suggested agenda")).toBeTruthy();
  });
});

describe("MeetingNotesCard", () => {
  it("seeks the audio, checks items and offers Add 2 to Reminders", async () => {
    const onSeek = vi.fn();
    const onAddItems = vi.fn();
    const user = userEvent.setup();
    render(<MeetingNotesCard notes={meetingNotes()} onSeek={onSeek} onAddItems={onAddItems} />);
    expect(offsetLabel(12 * 60_000 + 4_000)).toBe("12:04");
    await user.click(screen.getByRole("button", { name: "Play from 12:04" }));
    expect(onSeek).toHaveBeenCalledWith(724_000);
    await user.click(screen.getByRole("button", { name: "Add 2 items to Reminders" }));
    expect(onAddItems).toHaveBeenCalledWith(WORKFLOW_IDS.proposals.reminders);
    expect(screen.getByText(/never uploaded, reused or used for training/)).toBeTruthy();
    expect(screen.getByText("Written by AI")).toBeTruthy();
  });

  it("shows the transcript fallback when the summary failed", () => {
    render(
      <MeetingNotesCard
        notes={{ ...meetingNotes(), summary: [], decisions: [] }}
        onRetrySummary={() => {}}
      />,
    );
    expect(screen.getByText("Summary failed. The transcript is in your Library.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("workflow posts in the Feed", () => {
  it("renders the digest, prep and notes cards and snoozes a loop through the graph", async () => {
    const prefill = vi.fn();
    const { user, callsTo } = setup(<FeedScreen />, {
      edit: (w) => void withWorkflows(w),
      slots: { prefillComposer: prefill },
    });
    const digest = await screen.findByRole("article", { name: "Inbox digest" });
    // The real clock is past the fixture meeting, so its prep is one line.
    expect(screen.getByRole("article", { name: "Acme quarterly review" }).dataset.collapsed).toBe(
      "true",
    );
    expect(screen.getByRole("article", { name: "Roadmap sync" })).toBeTruthy();
    const [snooze] = within(digest).getAllByRole("button", { name: "Snooze" });
    await user.click(snooze as HTMLElement);
    await waitFor(() =>
      expect(callsTo("memory.loops.update")).toContainEqual({
        id: WORKFLOW_IDS.loops.dana,
        status: "snoozed",
      }),
    );
    const [nudge] = within(digest).getAllByRole("button", { name: "Draft a nudge" });
    await user.click(nudge as HTMLElement);
    expect(prefill).toHaveBeenCalledWith("Draft a nudge to Dana Ruiz about “contract draft”.");
  });
});
