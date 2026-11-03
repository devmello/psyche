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
