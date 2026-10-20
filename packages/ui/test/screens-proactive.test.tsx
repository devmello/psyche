import type { FeedPost } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, type FixtureWorld, IDS } from "../src/fixtures/index.ts";
import { FeedScreen } from "../src/screens/feed/FeedScreen.tsx";
import { feedKind, feedKindLabel, withCitationLinks } from "../src/screens/feed/feed-post.ts";
import { GoalPage } from "../src/screens/goals/GoalPage.tsx";
import { GoalsScreen } from "../src/screens/goals/GoalsScreen.tsx";
import { readGoalPlan } from "../src/screens/goals/goal-plan.ts";
import { evidenceTarget } from "../src/screens/ideas/evidence.tsx";
import { IdeasScreen } from "../src/screens/ideas/IdeasScreen.tsx";
import { InboxScreen } from "../src/screens/inbox/InboxScreen.tsx";
import type { UiSlots } from "../src/slots.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

function setup(
  ui: ReactElement,
  options: { edit?: (w: FixtureWorld) => void; slots?: UiSlots } = {},
) {
  let gateway: MockGateway | undefined;
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(
    <StoryWorld
      {...(options.edit ? { edit: options.edit } : {})}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate, ...options.slots }}
    >
      {ui}
    </StoryWorld>,
  );
  const gw = () => {
    if (gateway === undefined) throw new Error("gateway not ready");
    return gateway;
  };
  const callsTo = (method: string) => gw().calls.filter((c) => c.method === method);
  return { gw, callsTo, navigate, user };
}

const fixture = createFixtureWorld();
const post = (id: string): FeedPost => {
  const p = fixture.feed.find((x) => x.id === id);
  if (p === undefined) throw new Error(id);
  return p;
};

// --- Feed ---------------------------------------------------------------------------------------

describe("feed kind derivation (s12 gap 5)", () => {
  it("labels fixture posts by exploration, cluster, reasons, then briefing", () => {
    expect(feedKind(post(IDS.feed.briefing))).toBe("briefing");
    expect(feedKind(post(IDS.feed.reminder))).toBe("reminder");
    expect(feedKind(post(IDS.feed.suggestion))).toBe("suggestion");
    expect(feedKind(post(IDS.feed.watch))).toBe("watch");
    expect(feedKind(post(IDS.feed.news))).toBe("news");
    expect(feedKind(post(IDS.feed.exploration))).toBe("exploration");
    expect(feedKindLabel(post(IDS.feed.exploration))).toBe("Lisbon · exploration slot");
  });

  it("turns [n] markers into citation links", () => {
    const md = withCitationLinks("A [1] and [9].", [{ title: "x", url: "https://a.example/(x)" }]);
    expect(md).toBe("A [\\[1\\]](https://a.example/%28x%29) and [9].");
  });
});

describe("FeedScreen", () => {
  it("renders the bounded brief with kind labels, sources and the end marker", async () => {
    const { user } = setup(<FeedScreen onAsk={() => {}} />);
    expect(await screen.findByText("Today · 7 posts")).toBeTruthy();
    const briefing = screen.getByRole("article", { name: "Two things before your 10:00" });
    expect(within(briefing).getByText("Briefing")).toBeTruthy();
    expect(within(briefing).getByText("Sources (3)")).toBeTruthy();
    for (const name of ["Like", "Save", "Ask Wren"]) {
      expect(within(briefing).getByRole("button", { name })).toBeTruthy();
    }
    // Follow, Not interested and Hide source sit under ⋯ (§3.9).
    expect(within(briefing).queryByRole("button", { name: /Hide acme\.com/ })).toBeNull();
    await user.click(
      within(briefing).getByRole("button", {
        name: "More feedback on Two things before your 10:00",
      }),
    );
    expect(await screen.findByRole("menuitem", { name: /Hide acme\.com/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Not interested/ })).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: "Follow topic" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.getByText("News cluster")).toBeTruthy();
    expect(screen.getByText("Lisbon · exploration slot")).toBeTruthy();
    expect(screen.getByText("That's it for today. Next brief 07:00.")).toBeTruthy();
  });

  it("hides a post at once on Not interested and restores it from the undo toast", async () => {
    const { callsTo, user } = setup(<FeedScreen />);
    const card = await screen.findByRole("article", {
      name: "Tram 28 runs a shorter route in November",
    });
    await user.click(within(card).getByRole("button", { name: /^More feedback on/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Not interested/ }));
    expect(screen.queryByRole("article", { name: /Tram 28/ })).toBeNull();
    await waitFor(() => expect(callsTo("feed.feedback")).toHaveLength(1));
    expect(callsTo("feed.feedback")[0]?.params).toMatchObject({
      postId: IDS.feed.lisbon,
      feedback: "not_interested",
    });
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(callsTo("feed.feedback")).toHaveLength(2));
    expect(callsTo("feed.feedback")[1]?.params).toMatchObject({ feedback: null });
    expect(await screen.findByRole("article", { name: /Tram 28/ })).toBeTruthy();
  });

  it("sends the topic with Follow and toggles Like", async () => {
    const { callsTo, user } = setup(<FeedScreen />);
    const news = await screen.findByRole("article", { name: /manipulation benchmarks/ });
    await user.click(within(news).getByRole("button", { name: /^More feedback on/ }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Follow: robotics manipulation" }),
    );
    await waitFor(() =>
      expect(callsTo("feed.feedback")[0]?.params).toMatchObject({
        feedback: "follow_topic",
        topic: "robotics manipulation",
      }),
    );
    const watch = screen.getByRole("article", { name: /Headphones dropped/ });
    const like = within(watch).getByRole("button", { name: "Like" });
    expect(like.getAttribute("aria-pressed")).toBe("true");
    await user.click(like);
    await waitFor(() =>
      expect(callsTo("feed.feedback").at(-1)?.params).toMatchObject({ feedback: null }),
    );
  });

  it("navigates to the instructions editor and asks the persona about a post", async () => {
    const onAsk = vi.fn();
    const { navigate, user } = setup(<FeedScreen onAsk={onAsk} />);
    await user.click(await screen.findByRole("button", { name: "What should I write about" }));
    expect(navigate).toHaveBeenCalledWith("/feed/instructions");
    const card = screen.getByRole("article", { name: "Two things before your 10:00" });
    await user.click(within(card).getByRole("button", { name: "Ask Wren" }));
    expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ id: IDS.feed.briefing }));
  });

  it("offers to generate the first brief on first run", async () => {
    const { callsTo, user } = setup(<FeedScreen />, {
      edit: (w) => {
        w.feed = [];
      },
    });
    expect(
      await screen.findByText("No brief yet. Generate the first one, or wait until 07:00."),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Generate the first brief" }));
    await waitFor(() => expect(callsTo("feed.generate")).toHaveLength(1));
  });
});

// --- Ideas --------------------------------------------------------------------------------------

describe("evidence routes", () => {
  it("maps refs to in-app routes or web links", () => {
    expect(evidenceTarget("thread:th_main").route).toBe("/chat/th_main");
    expect(evidenceTarget("task:task_x").route).toBe("/agent/activity/task_x");
    expect(evidenceTarget("connector:conn_outlook").route).toBe("/settings/connectors");
    expect(evidenceTarget("https://a.example/x").href).toBe("https://a.example/x");
    expect(evidenceTarget("gmail:18b2")).toEqual({ route: null, href: null });
  });
});

describe("IdeasScreen", () => {
  it("accepts an idea as recurring and removes it from the list", async () => {
    const { callsTo, user } = setup(<IdeasScreen />);
    const card = await screen.findByRole("article", {
      name: "Cancel the unused streaming subscription",
    });
    expect(within(card).getByText(/Because:/)).toBeTruthy();
    expect(within(card).getByText(/~10 min · needs 1 approval/)).toBeTruthy();
    await user.click(within(card).getByRole("checkbox", { name: "Make recurring" }));
    // The toggle names its cadence; a recurring task needs a schedule.
    const cadence = within(card).getByRole("combobox", { name: "Cadence" });
    expect((cadence as HTMLSelectElement).value).toBe("monthly");
    await user.selectOptions(cadence, "weekly");
    await user.click(within(card).getByRole("button", { name: "Let's do it" }));
    await waitFor(() => expect(callsTo("ideas.accept")).toHaveLength(1));
    expect(callsTo("ideas.accept")[0]?.params).toEqual({
      ideaId: IDS.ideas.subscription,
      recurring: true,
      schedule: "0 9 * * 1",
    });
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: /streaming subscription/ })).toBeNull(),
    );
  });

  it("dismisses with a reason from the menu", async () => {
    const { callsTo, user } = setup(<IdeasScreen />);
    const card = await screen.findByRole("article", { name: "Friday afternoon week review" });
    await user.click(within(card).getByRole("button", { name: "Dismiss" }));
    await user.click(await screen.findByRole("menuitem", { name: "Never from this source" }));
    await waitFor(() =>
      expect(callsTo("ideas.dismiss")[0]?.params).toEqual({
        ideaId: IDS.ideas.automation,
        reason: "never_from_source",
      }),
    );
  });

  it("links evidence and opens skill drafts and edits", async () => {
    const onEdit = vi.fn();
    const { navigate, user } = setup(<IdeasScreen onEdit={onEdit} />);
    await user.click(await screen.findByRole("button", { name: /3 Fridays/ }));
    expect(navigate).toHaveBeenCalledWith(`/chat/${IDS.threads.main}`);
    await user.click(screen.getByRole("button", { name: "View SKILL.md" }));
    expect(navigate).toHaveBeenCalledWith(
      `/agent/soul?file=${encodeURIComponent("skills/weekly-expense-export/SKILL.md")}`,
    );
    const card = screen.getByRole("article", { name: "Friday afternoon week review" });
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: IDS.ideas.automation }));
    // Automation ideas already recur, and skill drafts never do: neither has the toggle.
    expect(within(card).queryByRole("checkbox")).toBeNull();
    expect(within(card).getByText(/Repeats on the schedule it proposes/)).toBeTruthy();
    const skill = screen.getByRole("article", { name: /Weekly expense export/ });
    expect(within(skill).queryByRole("checkbox")).toBeNull();
  });

  it("shows the empty state", async () => {
    setup(<IdeasScreen />, {
      edit: (w) => {
        w.ideas = [];
      },
    });
    expect(
      await screen.findByText("Ideas come from your goals, conversations and connected accounts."),
    ).toBeTruthy();
  });
});

// --- Goals --------------------------------------------------------------------------------------

describe("GoalsScreen", () => {
  it("groups goals by category with check-ins and milestone progress", async () => {
    const { navigate, user } = setup(<GoalsScreen />);
    expect(await screen.findByRole("heading", { name: "Health" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Finance" })).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Run a half marathon in May: 2 of 4 milestones" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Next check-in Mon 08:00").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Run a half marathon in May" }));
    expect(navigate).toHaveBeenCalledWith(`/goals/${IDS.goals.halfMarathon}`);
  });

  it("confirms an inferred goal only on Confirm", async () => {
    const { callsTo, user } = setup(<GoalsScreen />);
    const card = await screen.findByRole("article", {
      name: "Learn basic Portuguese before Lisbon",
    });
    expect(within(card).getByText(/Because:/)).toBeTruthy();
    expect(callsTo("goals.decide")).toHaveLength(0);
    await user.click(within(card).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(callsTo("goals.decide")[0]?.params).toEqual({
        goalId: IDS.goals.candidate,
        decision: "confirm",
      }),
    );
    expect(await screen.findByRole("heading", { name: "Learning" })).toBeTruthy();
  });

  it("hides a candidate for this visit on Later", async () => {
    const { callsTo, user } = setup(<GoalsScreen />);
    const card = await screen.findByRole("article", { name: /Portuguese/ });
    await user.click(within(card).getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("article", { name: /Portuguese/ })).toBeNull();
    await waitFor(() =>
      expect(callsTo("goals.decide")[0]?.params).toMatchObject({ decision: "later" }),
    );
  });

  it("shows the empty state", async () => {
    setup(<GoalsScreen />, {
      edit: (w) => {
        w.goals = [];
      },
    });
    expect(await screen.findByText("Tell Wren a goal in chat, or add one here.")).toBeTruthy();
  });
});

describe("GoalPage", () => {
  it("reads the plan convention", () => {
    const goal = fixture.goals.find((g) => g.id === IDS.goals.halfMarathon);
    if (goal === undefined) throw new Error("fixture");
    const plan = readGoalPlan(goal);
    expect(plan.milestones.map((m) => m.done)).toEqual([true, true, false, false]);
    expect(plan.planArtifactId).toBe(IDS.artifacts.planPdf);
    expect(plan.checkins[0]?.at).toBe("2026-10-12T08:00:00Z");
  });

  it("shows milestones, plan, linked tasks, watches and notes", async () => {
    const openArtifact = vi.fn();
    const { user } = setup(<GoalPage goalId={IDS.goals.halfMarathon} />, {
      edit: (w) => {
        for (const t of w.tasks) if (t.id === IDS.tasks.priceWatch) t.createdFrom = "goal";
      },
      slots: { openArtifact },
    });
    expect(await screen.findByRole("heading", { name: "Run a half marathon in May" })).toBeTruthy();
    expect(screen.getByText("15k")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Price watch" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "registration page" })).toBeTruthy();
    expect(screen.getByText(/Long runs on Sunday mornings/)).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: /12-week plan/ }));
    expect(openArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: IDS.artifacts.planPdf }),
    );
  });

  it("needs a typed confirmation to delete", async () => {
    const onDelete = vi.fn(() => Promise.resolve());
    const { user } = setup(<GoalPage goalId={IDS.goals.sleep} onDelete={onDelete} />);
    await user.click(
      await screen.findByRole("button", { name: "More actions for Sleep 7 hours on weeknights" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Delete goal/ }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete goal" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/Type "delete"/), "delete");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await user.click(confirm);
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: IDS.goals.sleep }));
  });
});

// --- Inbox --------------------------------------------------------------------------------------

describe("InboxScreen", () => {
  const rowFor = async (title: RegExp | string) =>
    (await screen.findByRole("heading", { name: title })).closest("article") as HTMLElement;

  it("approves inline with scope once and shows the countdown", async () => {
    const { callsTo, user } = setup(<InboxScreen now={STORY_NOW} />);
    const row = await rowFor("Send email to jane.ortiz@example.com");
    expect(within(row).getByText("Approval")).toBeTruthy();
    expect(await within(row).findByText("28:41")).toBeTruthy();
    const approve = await within(row).findByRole("button", { name: /^Approve once:/ });
    // Deny sits left of Approve, as on the approval card.
    const deny = within(row).getByRole("button", { name: /^Deny:/ });
    expect(deny.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Inline buttons arm 400 ms after they appear.
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    await user.click(approve);
    await waitFor(() => expect(callsTo("approvals.answer")).toHaveLength(1));
    expect(callsTo("approvals.answer")[0]?.params).toMatchObject({
      approvalId: IDS.approvals.sendEmail,
      decision: "approve",
      scope: "once",
    });
    expect(await within(row).findByText("Approved")).toBeTruthy();
    await waitFor(() => expect(callsTo("notifications.markRead")).toHaveLength(1));
  });

  it("sends purchases and fills to the full card instead of inline buttons", async () => {
    const { navigate, user } = setup(<InboxScreen now={STORY_NOW} />, {
      edit: (w) => {
        const n = w.notifications.find((x) => x.id === IDS.notifications.approval);
        if (n) n.approvalId = IDS.approvals.purchase;
      },
    });
    const row = await rowFor("Send email to jane.ortiz@example.com");
    const open = await within(row).findByRole("button", { name: "Open card" });
    expect(within(row).queryByRole("button", { name: /^Approve/ })).toBeNull();
    await user.click(open);
    expect(navigate).toHaveBeenCalledWith(`/chat/${IDS.threads.dentist}`);
  });

  it("answers, retries and resolves reminders", async () => {
    const { callsTo, navigate, user } = setup(<InboxScreen now={STORY_NOW} />);
    const input = await rowFor("Trip to Lisbon - which dates?");
    await user.click(within(input).getByRole("button", { name: "Answer" }));
    expect(navigate).toHaveBeenCalledWith(`/chat/${IDS.threads.lisbon}`);

    const failed = await rowFor("Subscription audit");
    await user.click(within(failed).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(callsTo("tasks.retry")[0]?.params).toEqual({ taskId: IDS.tasks.subscriptionAudit }),
    );

    const reminder = await rowFor("Half marathon check-in");
    await user.click(within(reminder).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(callsTo("notifications.resolve").at(-1)?.params).toEqual({
        notificationId: IDS.notifications.reminder,
        actionId: "done",
      }),
    );
    expect(await within(reminder).findByText("Resolved")).toBeTruthy();
  });

  it("marks unread rows read and marks stale rows", async () => {
    const { callsTo, user } = setup(<InboxScreen now={STORY_NOW} />, {
      edit: (w) => {
        const n = w.notifications.find((x) => x.id === IDS.notifications.proactive);
        if (n) {
          n.staleAt = "2026-10-18T10:00:00Z";
          n.staleReason = "the Gateway restarted";
        }
      },
    });
    const idea = await rowFor("Cancel the unused streaming subscription");
    expect(within(idea).getByText(/Stale · the Gateway restarted/)).toBeTruthy();
    expect(within(idea).getByText("Unread")).toBeTruthy();
    await user.click(within(idea).getByRole("button", { name: /Mark ".*" read/ }));
    await waitFor(() =>
      expect(callsTo("notifications.markRead")[0]?.params).toEqual({
        notificationIds: [IDS.notifications.proactive],
      }),
    );
    expect(within(idea).queryByText("Unread")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(callsTo("notifications.markRead")).toHaveLength(2));
  });

  it("shows the empty state", async () => {
    setup(<InboxScreen now={STORY_NOW} />, {
      edit: (w) => {
        w.notifications = [];
      },
    });
    expect(await screen.findByText("Nothing needs you.")).toBeTruthy();
  });
});

describe("page columns (#512)", () => {
  /** The page column under a screen's labelled section: its classes and what's inside it. */
  const column = (name: string) =>
    screen.getByRole("region", { name }).firstElementChild as HTMLElement;

  it("centres Goals and Ideas in the same prose column as Feed", async () => {
    render(
      <StoryWorld>
        <FeedScreen />
        <GoalsScreen />
        <IdeasScreen />
      </StoryWorld>,
    );
    await screen.findByRole("heading", { name: "Goals" });
    const feed = column("Feed").className;
    for (const name of ["Goals", "Ideas"]) {
      const c = column(name);
      expect(c.className, name).toBe(feed);
      expect(c.className).toContain("mx-auto");
      // Nothing inside narrows the content to a left-aligned measure again.
      expect(c.querySelector('[class*="max-w-[68ch]"]'), name).toBeNull();
    }
  });
});
