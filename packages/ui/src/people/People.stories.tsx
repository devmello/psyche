import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactElement, useState } from "react";
import { kitchen, samLee, suggestions, summaries } from "../fixtures/people.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { EntityCard, PersonCard, ProjectCard } from "./EntityCard.tsx";
import { EntityRow } from "./EntityRow.tsx";
import { PeopleSheetSection } from "./PeopleSheetSection.tsx";
import { SuggestionCard } from "./SuggestionCard.tsx";
import type { EntityView, GraphLoopStatus } from "./types.ts";

/** People and projects (docs/memory/people-and-projects-2026.md §6.4, §6.5) on fixtures. */

/** A card whose writes apply locally, so edits, loops and status can be tried in the story. */
function LiveCard({ initial }: { initial: EntityView }): ReactElement {
  const [entity, setEntity] = useState(initial);
  return (
    <EntityCard
      entity={entity}
      now={STORY_NOW}
      className="max-w-[640px]"
      onSetFact={(e, attribute, value) =>
        setEntity({
          ...e,
          facts: [
            {
              id: `fact_${attribute}_${e.facts.length}`,
              attribute,
              value,
              provenance: "owner",
              source: { kind: "owner", at: new Date(STORY_NOW).toISOString() },
              recordedAt: new Date(STORY_NOW).toISOString(),
            },
            ...e.facts.filter((f) => f.attribute !== attribute || f.provenance !== "owner"),
          ],
        })
      }
      onRetractFact={(e, fact) =>
        setEntity({ ...e, facts: e.facts.filter((f) => f.id !== fact.id) })
      }
      onUpdateLoop={(e, loop, status: GraphLoopStatus) =>
        setEntity({ ...e, loops: e.loops.map((l) => (l.id === loop.id ? { ...l, status } : l)) })
      }
      onSaveNotes={(e, notes) => setEntity({ ...e, notes })}
      onSetStatus={(e, status) => setEntity({ ...e, projectStatus: status })}
      onTogglePin={(e) => setEntity({ ...e, pinned: !e.pinned })}
      onMerge={() => {}}
      onForget={() => {}}
      onOpenEntity={() => {}}
      onOpenLink={() => {}}
    />
  );
}

const meta = {
  title: "People/Cards",
  component: PersonCard,
  parameters: { layout: "padded" },
  args: { entity: samLee, now: STORY_NOW },
} satisfies Meta<typeof PersonCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Person: Story = { render: () => <LiveCard initial={samLee} /> };

export const Project: Story = { render: () => <LiveCard initial={kitchen} /> };

/** A new person: no facts, loops, projects, interactions or notes yet. */
export const PersonEmpty: Story = {
  render: () => (
    <PersonCard
      className="max-w-[640px]"
      now={STORY_NOW}
      entity={{
        ...samLee,
        id: "ent_new",
        name: "Priya Shah",
        pinned: false,
        summary: null,
        facts: [],
        edges: [],
        loops: [],
        interactions: [],
        notes: null,
      }}
      onSetFact={() => {}}
      onSaveNotes={() => {}}
    />
  ),
};

export const Loading: Story = {
  render: () => <PersonCard entity={null} now={STORY_NOW} loading />,
};

export const LoadError: Story = {
  render: () => (
    <PersonCard entity={null} now={STORY_NOW} error="entity not found" onRetry={() => {}} />
  ),
};

/** Read-only (no write callbacks): no Edit, no ⋯, notes not editable. */
export const ReadOnly: Story = {
  render: () => <ProjectCard entity={kitchen} now={STORY_NOW} className="max-w-[640px]" />,
};

export const Dark: Story = {
  render: () => <LiveCard initial={samLee} />,
  globals: { theme: "dark" },
};

/** Compact width (redesign §5.11). */
export const Compact: Story = {
  render: () => (
    <div className="w-[390px]">
      <LiveCard initial={kitchen} />
    </div>
  ),
};

export const Rows: Story = {
  render: function Render() {
    const [selected, setSelected] = useState<string>(summaries[0]?.id ?? "");
    return (
      <div className="flex w-[360px] flex-col gap-0.5">
        {summaries.map((s) => (
          <EntityRow
            key={s.id}
            entity={s}
            now={STORY_NOW}
            selected={s.id === selected}
            onOpen={(e) => setSelected(e.id)}
          />
        ))}
      </div>
    );
  },
};

export const Suggestions: Story = {
  render: () => (
    <div className="flex max-w-[520px] flex-col gap-3">
      {suggestions.map((s) => (
        <SuggestionCard key={s.id} suggestion={s} onAnswer={() => {}} />
      ))}
    </div>
  ),
};

/** Soul & Memory → People & projects on the mock Gateway, at the sheet's 420 px. */
export const SheetSection: Story = {
  decorators: [withWorld()],
  render: () => (
    <div className="w-[420px]">
      <PeopleSheetSection now={STORY_NOW} />
    </div>
  ),
};
