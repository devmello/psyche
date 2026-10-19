import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld } from "../../fixtures/index.ts";
import { withWorld } from "../../stories/harness.tsx";
import { SearchScreen, SearchView } from "./SearchScreen.tsx";

const world = createFixtureWorld();

const meta = {
  title: "Screens/Search/Search",
  component: SearchScreen,
  decorators: [withWorld()],
  args: { debounceMs: 0 },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SearchScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyQuery: Story = {};
export const Results: Story = { args: { initialQuery: "dentist" } };
export const ScopedToFeed: Story = { args: { initialQuery: "in:feed dentist" } };
export const TypeFilter: Story = { args: { initialQuery: "type:pdf permission" } };
export const UnsupportedFilter: Story = { args: { initialQuery: "in:ideas from:alice dentist" } };
export const NoResults: Story = { args: { initialQuery: "lighthouse" } };

export const Loading: Story = {
  render: () => <SearchView query="dentist" hits={[]} loading />,
};

export const SearchError: Story = {
  render: () => (
    <SearchView query="dentist" hits={[]} error="the index is rebuilding" onRetry={() => {}} />
  ),
};

export const MemoryProvenance: Story = {
  render: () => (
    <SearchView query="morning" hits={world.searchHits.filter((h) => h.scope === "memory")} />
  ),
};
