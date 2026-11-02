import type { FeedPost, NudgeItem } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement } from "react";
import type { FixtureWorld } from "../fixtures/index.ts";
import { FeedPostCard } from "../screens/feed/FeedPostCard.tsx";
import { StoryWorld } from "../stories/harness.tsx";
import { RelationshipNudgesSettings } from "./NudgeSettings.tsx";

/**
 * Relationship nudges in the ink direction: a paper card, the one accent on "Draft a reply",
 * quiet ghost buttons for the rest, and amber only for a promise past its due date.
 */

const items: Record<string, NudgeItem> = {
  unanswered: {
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
        text: "Follow up on: moved to Lisbon in September",
        evidence:
          "Life event: moved to Lisbon in September · their own words, accepted by you · Oct 3",
      },
      { text: "You promised: “send the deck”", evidence: "Your promise · Oct 28" },
    ],
  },
  drift: {
    id: "nd_drift",
    kind: "drift",
    entityId: "ent_sam",
    name: "Sam Cole",
    text: "You usually talk to Sam Cole every 2 weeks; it's been 6 weeks.",
    daysAgo: 42,
    channel: null,
    date: null,
    overdue: false,
  },
  birthday: {
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
  promise: {
    id: "nd_promise",
    kind: "promise",
    entityId: "ent_jordan",
    name: "Jordan Lee",
    text: "You promised Jordan Lee: “send the deck”. Did you do it?",
    daysAgo: 4,
    channel: null,
    date: null,
    overdue: true,
  },
};

const post = (item: NudgeItem, title: string): FeedPost => ({
  id: `post_${item.id}`,
  title,
  bodyMd: item.text,
  citations: [],
  cluster: null,
  score: 1,
  reasons: ["relationship nudge"],
  exploration: false,
  briefingId: null,
  feedback: null,
  createdAt: "2026-10-28T09:00:00.000Z",
  kind: "suggestion",
  refs: { nudgeId: item.id },
});

const withNudges = (list: NudgeItem[]) => (w: FixtureWorld) => {
  w.review = { items: [], quarantine: [], runs: [], nudges: { items: list, muted: [] } };
};

function Card({ item, title, gone = false }: { item: NudgeItem; title: string; gone?: boolean }) {
  return (
    <StoryWorld edit={withNudges(gone ? [] : [item])} slots={{ prefillComposer: () => {} }}>
      <div className="max-w-xl p-4">
        <FeedPostCard post={post(item, title)} />
      </div>
    </StoryWorld>
  );
}

const meta = {
  title: "Nudges/Feed card",
  component: Card,
  args: { item: items.unanswered as NudgeItem, title: "Reply to Priya Rao?" },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unanswered: Story = {};
/** Priya Rao with nothing on file: the card has no starters, only the actions. */
export const UnansweredNothingKnown: Story = {
  args: { item: { ...(items.unanswered as NudgeItem), starters: [] } },
};
export const Drifting: Story = {
  args: { item: items.drift as NudgeItem, title: "Catch up with Sam Cole" },
};
export const Birthday: Story = {
  args: { item: items.birthday as NudgeItem, title: "Coming up with Alex Kim" },
};
export const PromisePastDue: Story = {
  args: { item: items.promise as NudgeItem, title: "A promise to Jordan Lee" },
};
export const AlreadyHandled: Story = { args: { gone: true } };

function SettingsGroup({ enabled }: { enabled: boolean }): ReactElement {
  return (
    <StoryWorld>
      <div className="max-w-xl p-4">
        <RelationshipNudgesSettings enabled={enabled} sensitivity="normal" onChange={() => {}} />
      </div>
    </StoryWorld>
  );
}

export const SettingsOff: StoryObj<typeof SettingsGroup> = {
  render: () => <SettingsGroup enabled={false} />,
};
export const SettingsOn: StoryObj<typeof SettingsGroup> = {
  render: () => <SettingsGroup enabled />,
};
