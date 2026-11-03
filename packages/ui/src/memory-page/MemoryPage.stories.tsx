import type { ReviewItem } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PEOPLE_IDS } from "../fixtures/people.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { MemoryScreen } from "./MemoryScreen.tsx";

/**
 * Memory (docs/design/memory-everything-2026.md §6): the sidebar's fourth place, on the fixture
 * graph. One chip row (Everything, People, Projects, Work due, Events, More) with Review at the
 * end; Everything shows only the sections it can fill, and Work due stays empty until the work
 * store exists.
 */
const meta = {
  title: "Screens/Memory",
  component: MemoryScreen,
  decorators: [withWorld()],
  args: { now: STORY_NOW, onNavigate: () => {} },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MemoryScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Everything: Story = {};

export const Narrow: Story = {
  render: (args) => (
    <div className="max-w-[420px]">
      <MemoryScreen {...args} />
    </div>
  ),
};

/** Today's People page, Keep in touch included, moved in unchanged. */
export const People: Story = { args: { kind: "people" } };

export const Projects: Story = { args: { kind: "projects" } };

/** No work store yet: a calm empty page. */
export const WorkDue: Story = { args: { kind: "due" } };

export const Events: Story = { args: { kind: "events" } };

export const More: Story = { args: { kind: "more" } };

/** A person's page opens inside Memory, with Back to People. */
export const Person: Story = { args: { entity: PEOPLE_IDS.samLee } };

export const Empty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.graph.entities = w.graph.entities.filter((e) => e.isOwner);
      },
    }),
  ],
};

// --- Review (§6.4) -------------------------------------------------------------------------------

const AT = "2026-11-01T09:00:00.000Z";

function waiting(
  id: string,
  name: string,
  attribute: ReviewItem["fact"]["attribute"],
  value: string,
  quote: string,
  over: Partial<ReviewItem> = {},
): ReviewItem {
  return {
    fact: {
      id,
      entityId: `ent_${name}`,
      attribute,
      value,
      provenance: "agent",
      confidence: 0.9,
      sources: [],
      evidence: null,
      validFrom: AT,
      validTo: null,
      recordedAt: AT,
      supersededBy: null,
      retractedAt: null,
      review: "pending",
      sensitivity: "none",
      subjectKind: "owner_stated",
      lastSeenAt: AT,
    },
    entityName: name,
    citations: [
      {
        id: `c_${id}`,
        targetKind: "fact",
        targetId: id,
        source: "mail",
        docId: null,
        sourceRef: "m1",
        quote,
        start: 0,
        end: quote.length,
        sourceHash: "h",
        authorEntityId: null,
        provenance: "agent",
        observedAt: AT,
        createdAt: AT,
      },
    ],
    change: "new",
    previousValue: null,
    sentence: `${name}: ${attribute} ${value}`,
    ...over,
  };
}

/** The queue: facts grouped by person, with an amber count on the Review chip. */
export const Review: Story = {
  args: { view: "review" },
  decorators: [
    withWorld({
      edit: (w) => {
        w.review = {
          items: [
            waiting("f1", "Dana Reyes", "likes", "climbing", "Dana loves climbing"),
            waiting("f2", "Dana Reyes", "city", "Lisbon", "Dana moved to Lisbon in June", {
              change: "changed",
              previousValue: "Paris",
            }),
            waiting("f3", "Sam Lee", "employer", "Initech", "Sam just joined Initech"),
          ],
          quarantine: [],
          runs: [],
          senders: [{ entityId: "ent_sam", name: "Sam Lee", confirmed: 5, state: "offered" }],
        };
      },
    }),
  ],
};

/** Nothing waiting: no count on the chip and a calm empty queue. */
export const ReviewEmpty: Story = {
  args: { view: "review" },
  decorators: [
    withWorld({
      edit: (w) => {
        w.review = { items: [], quarantine: [], runs: [] };
      },
    }),
  ],
};
