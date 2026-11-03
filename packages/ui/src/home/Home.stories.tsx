import type { NudgeItem } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { FixtureWorld } from "../fixtures/index.ts";
import { withCatchUp } from "../fixtures/work.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { HomeScreen } from "./HomeScreen.tsx";

/**
 * Home (docs/design/home-2026.md): the fixture world's day, one column read top to bottom. Needs
 * you is amber and holds the one accent (the first Approve); the brief (three posts, the rest
 * behind "Show more"), suggestions (two), coming up, goals and keep in touch follow, ruled off
 * from each other, with a line of links to the deeper pages at the foot.
 */

const nudges: NudgeItem[] = [
  {
    id: "nd_unanswered",
    kind: "unanswered",
    entityId: "ent_priya",
    name: "Priya Rao",
    text: "You haven't replied to Priya Rao's message from 9 days ago.",
    daysAgo: 9,
    channel: "messages",
    date: null,
    overdue: false,
    starters: [
      {
        text: "Ask how the new job at Initech is going",
        evidence: "Employer: Initech · their own words, accepted by you · Oct 12",
      },
      {
        text: "You promised: “send the deck”",
        evidence: "Your promise · Oct 28",
      },
    ],
  },
  {
    id: "nd_birthday",
    kind: "birthday",
    entityId: "ent_alex",
    name: "Alex Kim",
    text: "Alex Kim's birthday is on Thursday",
    daysAgo: null,
    channel: null,
    date: "2026-11-05",
    overdue: false,
  },
];

const withNudges = (w: FixtureWorld) => {
  w.review = {
    ...(w.review ?? { items: [], quarantine: [], runs: [] }),
    nudges: { items: nudges, muted: [] },
  };
};

const meta = {
  title: "Screens/Home",
  component: HomeScreen,
  decorators: [withWorld({ edit: withNudges, slots: { prefillComposer: () => {} } })],
  args: { now: STORY_NOW, onNavigate: () => {} },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HomeScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Day: Story = {};

/** Nothing waits on the owner: the first idea takes the accent. */
export const NothingNeedsYou: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        withNudges(w);
        w.notifications = w.notifications.filter(
          (n) => n.kind !== "approval" && n.kind !== "input_needed",
        );
      },
    }),
  ],
};

/** A quiet day: no brief yet, no suggestions, nothing scheduled, no goals: only the Ask field. */
export const QuietDay: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.notifications = [];
        w.feed = [];
        w.ideas = [];
        w.goals = [];
        w.automations = [];
      },
    }),
  ],
};

/** A first visit: nothing said yet, so the Ask field offers things to try (consolidation §7). */
export const FirstVisit: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.notifications = [];
        w.feed = [];
        w.ideas = [];
        w.goals = [];
        w.automations = [];
        w.threads = w.threads
          .filter((e) => e.thread.kind === "main")
          .map((e) => ({ ...e, thread: { ...e.thread, lastMessageAt: null } }));
      },
    }),
  ],
};

/**
 * "Catching up" from `memory.catchup.list`: a mix of what is due (a work deliverable, a home
 * errand, a bill), at the top of Today in quiet ink, never amber. The one past-due question,
 * "Did you finish ...?", is amber and sits in Needs you with Handed in, Done and Still working.
 */
export const CatchingUp: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        withNudges(w);
        withCatchUp(w);
      },
    }),
  ],
};

/** Only the catch-up on a day with no posts: Today is drawn for it alone. */
export const CatchingUpAlone: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        withCatchUp(w);
        w.graph.catchUp = w.graph.catchUp?.filter((i) => i.ask !== true);
        w.notifications = [];
        w.feed = [];
        w.ideas = [];
        w.goals = [];
        w.automations = [];
      },
    }),
  ],
};

export const Narrow: Story = {
  render: (args) => (
    <div className="max-w-[420px]">
      <HomeScreen {...args} />
    </div>
  ),
};
