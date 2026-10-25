import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld, IDS } from "../../fixtures/index.ts";
import { STORY_NOW, withWorld } from "../../stories/harness.tsx";
import { LibraryItemView, LibraryScreen, LibraryView } from "./LibraryScreen.tsx";

const world = createFixtureWorld();
const item = (id: string) => {
  const i = world.library.find((x) => x.id === id);
  if (i === undefined) throw new Error(`fixture library item ${id} missing`);
  return i;
};

const meta = {
  title: "Screens/Library/Library",
  component: LibraryScreen,
  decorators: [withWorld()],
  args: {
    now: STORY_NOW,
    onReveal: () => {},
    onQuickLook: () => {},
    onSendToChat: () => {},
    onTrust: () => undefined,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof LibraryScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Documents: Story = { args: { section: "documents" } };
export const Images: Story = { args: { section: "images" } };
export const Artifacts: Story = { args: { section: "artifacts" } };
export const Downloads: Story = { args: { section: "downloads" } };
export const SystemFiles: Story = { args: { section: "system" } };

export const ListLayout: Story = {
  render: () => (
    <LibraryView
      items={world.library}
      section="documents"
      layout="list"
      now={STORY_NOW}
      taskTitles={{ [IDS.tasks.dentist]: "Dentist booking" }}
      onOpen={() => {}}
      onSendToChat={() => {}}
    />
  ),
};

export const FilteredEmpty: Story = {
  render: () => (
    <LibraryView
      items={world.library}
      section="documents"
      now={STORY_NOW}
      filters={{ type: "Image", taskId: null, date: "any" }}
    />
  ),
};

export const EmptySection: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.library = [];
      },
    }),
  ],
  args: { section: "artifacts" },
};

export const Loading: Story = {
  render: () => <LibraryView items={[]} section="documents" now={STORY_NOW} loading />,
};

export const LoadError: Story = {
  render: () => (
    <LibraryView
      items={[]}
      section="documents"
      now={STORY_NOW}
      error="the Gateway timed out"
      onRetry={() => {}}
    />
  ),
};

export const QuarantinedDownload: Story = {
  render: () => (
    <LibraryItemView
      item={item(IDS.library.invoiceDownload)}
      layout="grid"
      taskTitle="Dentist booking"
      onOpen={() => {}}
      onTrust={() => {}}
      onOpenTask={() => {}}
    />
  ),
};

/** Documents in dark appearance (Screens/* baselines shoot light only). */
export const Dark: Story = { args: { section: "documents" }, globals: { theme: "dark" } };

/** Compact width (§5.11): the tiles reflow; the toolbar's buttons become icons. */
export const Compact: Story = {
  args: { section: "documents" },
  decorators: [
    (S) => (
      <div className="w-[390px]">
        <S />
      </div>
    ),
  ],
};
