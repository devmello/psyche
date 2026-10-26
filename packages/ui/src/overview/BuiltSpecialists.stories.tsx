import type { Meta, StoryObj } from "@storybook/react-vite";
import { canvasFixtures } from "../fixtures/canvas.ts";
import { insightsFixtures } from "../fixtures/index.ts";
import { STORY_NOW, StoryWorld, withWorld } from "../stories/harness.tsx";
import { BuiltForYou, Specialists } from "./BuiltSpecialists.tsx";
import { OverviewScreen } from "./OverviewScreen.tsx";

/**
 * "Built for you" and "Specialists" (docs/design/agent-overview-2026.md §5.4): the artifact grid
 * with a real chart thumbnail, and the three latest specialist results.
 */
const meta = {
  title: "Overview/Built and specialists",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

type World = { artifacts: unknown[]; artifactHistory?: unknown; insights?: unknown };
const typical = (world: object) => {
  const fx = canvasFixtures();
  const w = world as World;
  w.artifacts.push(...fx.artifacts);
  w.artifactHistory = fx.artifactHistory;
  w.insights = insightsFixtures("typical");
};
const bare = (world: object) => {
  const w = world as World & { specialistJobs?: unknown[] };
  w.artifacts.length = 0;
  w.specialistJobs = [];
  w.insights = insightsFixtures("typical");
};
const noRoles = (world: object) => {
  typical(world);
  (world as { specialistRoles?: unknown[] }).specialistRoles = [];
};

function Sections({ width }: { width?: number }) {
  return (
    <div
      className="@container/overview flex h-dvh flex-col gap-4 overflow-auto bg-canvas p-6"
      style={width === undefined ? {} : { width }}
    >
      <BuiltForYou period="30d" now={STORY_NOW} />
      <Specialists period="30d" now={STORY_NOW} />
    </div>
  );
}

export const Desktop: Story = {
  render: () => (
    <StoryWorld edit={typical}>
      <Sections />
    </StoryWorld>
  ),
};

export const Compact: Story = {
  render: () => (
    <StoryWorld edit={typical}>
      <Sections width={390} />
    </StoryWorld>
  ),
};

/** Nothing built and no results in the period: quiet lines. */
export const Empty: Story = {
  render: () => (
    <StoryWorld edit={bare}>
      <Sections />
    </StoryWorld>
  ),
};

/** No specialist role is enabled: the Specialists card is not drawn. */
export const SpecialistsOff: Story = {
  render: () => (
    <StoryWorld edit={noRoles}>
      <Sections />
    </StoryWorld>
  ),
};

/** Under seven days of activity the screen shows neither section (§5.5). */
export const NewUser: Story = {
  decorators: [withWorld({ edit: typical })],
  render: () => (
    <div className="flex h-dvh min-h-0 flex-col overflow-auto bg-canvas">
      <OverviewScreen
        period="7d"
        onPeriodChange={() => {}}
        data={{ firstActivityAt: new Date(STORY_NOW - 2 * 86_400_000).toISOString() }}
        now={STORY_NOW}
      />
    </div>
  ),
};
