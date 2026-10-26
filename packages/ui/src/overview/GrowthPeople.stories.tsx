import type { Meta, StoryObj } from "@storybook/react-vite";
import type { FixtureWorld } from "../fixtures/index.ts";
import { emptyInsights, growthFeedPost, insightsFixtures } from "../fixtures/index.ts";
import { STORY_NOW, StoryWorld } from "../stories/harness.tsx";
import { GrowthAndPeople } from "./GrowthAndPeople.tsx";
import type { OverviewPeriod } from "./period.ts";

/**
 * The Overview's Growth and People & projects sections (docs/design/agent-overview-2026.md §5.4):
 * lesson counts, metrics, milestones and the weekly card row beside the radial people map, with
 * its list equivalent at compact width, and the empty, new-user and graph-paused states.
 */
const meta = {
  title: "Overview/Growth and People",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

type InsightState = "new" | "typical" | "heavy";

function worldFor(opts: {
  insights: InsightState | "empty";
  graph: "on" | "off";
  growth: "some" | "none";
}): (world: FixtureWorld) => void {
  return (world) => {
    Object.assign(world, {
      insights:
        opts.insights === "empty"
          ? { "7d": emptyInsights("7d"), "30d": emptyInsights("30d"), all: emptyInsights("all") }
          : insightsFixtures(opts.insights),
    });
    world.graph.status = {
      ...world.graph.status,
      enabled: opts.graph === "on",
      counts: {
        people: opts.insights === "heavy" ? 41 : 14,
        orgs: 3,
        projects: opts.insights === "heavy" ? 12 : 6,
        places: 0,
        openLoops: 5,
        pendingSuggestions: 0,
      },
    };
    if (opts.growth === "some") world.feed = [growthFeedPost(), ...world.feed];
    else {
      world.lessons = [];
      world.milestones = [];
      world.feedbackEvents = [];
    }
  };
}

function Page({
  edit,
  period = "30d",
  width,
  compact,
}: {
  edit: (world: FixtureWorld) => void;
  period?: OverviewPeriod;
  width?: number;
  compact?: boolean;
}) {
  return (
    <StoryWorld edit={edit}>
      <div
        className="@container/overview flex min-h-0 flex-col overflow-auto bg-canvas p-4"
        data-testid="overview"
        style={width === undefined ? {} : { width }}
      >
        <GrowthAndPeople
          period={period}
          now={STORY_NOW}
          {...(compact === undefined ? {} : { compact })}
        />
      </div>
    </StoryWorld>
  );
}

const TYPICAL = worldFor({ insights: "typical", graph: "on", growth: "some" });

/** A typical month: Growth beside the map. */
export const Typical: Story = { render: () => <Page edit={TYPICAL} width={1100} /> };

/** A heavy year: the full 12 nodes on the rings. */
export const Heavy: Story = {
  render: () => (
    <Page
      edit={worldFor({ insights: "heavy", graph: "on", growth: "some" })}
      period="all"
      width={1100}
    />
  ),
};

/** Compact (< 720 px): the list is the default view, the map is behind "Show map". */
export const Compact: Story = {
  render: () => <Page edit={TYPICAL} width={390} compact />,
};

/** Between 720 and 1100 px: Growth above People, the map shown. */
export const Medium: Story = { render: () => <Page edit={TYPICAL} width={840} /> };

/** A quiet period: nothing learned and nobody seen yet. */
export const Empty: Story = {
  render: () => (
    <Page edit={worldFor({ insights: "empty", graph: "on", growth: "none" })} width={1100} />
  ),
};

/** Day 2: two entities, no lessons. */
export const NewUser: Story = {
  render: () => (
    <Page
      edit={worldFor({ insights: "new", graph: "on", growth: "none" })}
      period="7d"
      width={1100}
    />
  ),
};

/** The people and projects graph is turned off. */
export const GraphPaused: Story = {
  render: () => (
    <Page edit={worldFor({ insights: "typical", graph: "off", growth: "some" })} width={1100} />
  ),
};
