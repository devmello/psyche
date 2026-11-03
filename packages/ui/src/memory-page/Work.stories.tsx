import type { GraphAnchor } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { GroupedList } from "../components/page.tsx";
import { WORK_IDS, withWorkWorld, workView } from "../fixtures/work.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { Anchors } from "./Anchors.tsx";
import { ConnectedTimeline } from "./Timeline.tsx";
import { WorkCard } from "./WorkCard.tsx";
import { QuickAdd } from "./WorkDue.tsx";

/**
 * The pieces of the work pages (docs/design/memory-everything-2026.md §6.2, §6.3): the one-line
 * quick add and what it understood, the Linked sources, the timeline and the card of a course or
 * an assignment. The pages themselves are under Screens/Memory.
 */
const meta = {
  title: "Memory/Work",
  decorators: [withWorld({ edit: withWorkWorld })],
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const shell = "max-w-[640px]";

/** The form says what it read before it saves: the title, the course it found and the day. */
export const QuickAddUnderstood: Story = {
  render: () => (
    <div className={shell}>
      <QuickAdd now={STORY_NOW} initialText="Lab report 4, CHEM 1B, Fri" onClose={() => {}} />
    </div>
  ),
};

/** A course that matches nothing is said out loud, and the item is added without one. */
export const QuickAddNoCourse: Story = {
  render: () => (
    <div className={shell}>
      <QuickAdd now={STORY_NOW} initialText="Poster, BIO 20, Mon" onClose={() => {}} />
    </div>
  ),
};

/** Empty: a hint with the shape of the line. */
export const QuickAddEmpty: Story = {
  render: () => (
    <div className={shell}>
      <QuickAdd now={STORY_NOW} onClose={() => {}} />
    </div>
  ),
};

const AT = "2026-09-02T09:00:00Z";
const anchors: GraphAnchor[] = [
  {
    id: "a1",
    entityId: WORK_IDS.math,
    kind: "folder",
    ref: "~/School/MATH21",
    label: "MATH21",
    addedBy: "owner",
    confirmed: true,
    createdAt: AT,
  },
  {
    id: "a2",
    entityId: WORK_IDS.math,
    kind: "reminder_list",
    ref: "MATH 21",
    label: "MATH 21",
    addedBy: "rule",
    confirmed: true,
    createdAt: AT,
  },
  {
    id: "a3",
    entityId: WORK_IDS.math,
    kind: "mail_thread",
    ref: "thread-lw7",
    label: "Lecture Work 7 is posted",
    addedBy: "model",
    confirmed: false,
    createdAt: AT,
  },
];

/** What is linked, who linked it, and a model's guess that routes nothing until the owner links it. */
export const LinkedSources: Story = {
  render: () => (
    <div className={shell}>
      <GroupedList title="Linked">
        <Anchors anchors={anchors} onAdd={() => {}} onRemove={() => {}} />
      </GroupedList>
    </div>
  ),
};

export const LinkedEmpty: Story = {
  render: () => (
    <div className={shell}>
      <GroupedList title="Linked">
        <Anchors anchors={[]} onAdd={() => {}} />
      </GroupedList>
    </div>
  ),
};

/** A course's timeline: its own rows and its assignments', newest first, each with its source chip. */
export const CourseTimeline: Story = {
  render: () => (
    <div className={shell}>
      <GroupedList title="Timeline">
        <ConnectedTimeline
          entityId={WORK_IDS.math}
          now={STORY_NOW}
          names={
            new Map([
              [WORK_IDS.lw7, "Lecture Work 7"],
              [WORK_IDS.lw6, "Lecture Work 6"],
            ])
          }
        />
      </GroupedList>
    </div>
  ),
};

/** The card with no host behind it: read-only, no controls that write. */
export const CardReadOnlyCourse: Story = {
  render: () => <WorkCard entity={workView(WORK_IDS.math)} now={STORY_NOW} className={shell} />,
};

/** The card of an assignment with every control wired to nothing, to see the controls. */
export const CardAssignment: Story = {
  render: () => (
    <WorkCard
      entity={workView(WORK_IDS.lw7)}
      now={STORY_NOW}
      className={shell}
      onSetWorkStatus={() => {}}
      onSetDueAt={() => {}}
      onSetFact={() => {}}
      onTogglePrivate={() => {}}
      onOpenEntity={() => {}}
    />
  ),
};
