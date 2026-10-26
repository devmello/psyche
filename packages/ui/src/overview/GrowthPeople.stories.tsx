import type { Meta, StoryObj } from "@storybook/react-vite";
import type { FixtureWorld } from "../fixtures/index.ts";
import { emptyInsights, growthFeedPost, insightsFixtures } from "../fixtures/index.ts";
import { STORY_NOW, StoryWorld } from "../stories/harness.tsx";
import { GrowthSection } from "./GrowthSection.tsx";
import { PeopleSection } from "./PeopleSection.tsx";
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
  part,
  period = "30d",
  width = 920,
  compact,
}: {
  edit: (world: FixtureWorld) => void;
  part: "growth" | "people";
  period?: OverviewPeriod;
  width?: number;
  compact?: boolean;
}) {
  return (
    <StoryWorld edit={edit}>
      <div
        className="@container/overview flex min-h-0 flex-col overflow-auto bg-canvas p-4"
        data-testid="overview"
        style={{ width }}
      >
        {part === "growth" ? (
          <GrowthSection period={period} now={STORY_NOW} />
        ) : (
          <PeopleSection
            period={period}
            now={STORY_NOW}
            {...(compact === undefined ? {} : { compact })}
          />
        )}
      </div>
    </StoryWorld>
  );
}

const TYPICAL = worldFor({ insights: "typical", graph: "on", growth: "some" });
const HEAVY = worldFor({ insights: "heavy", graph: "on", growth: "some" });
const QUIET = worldFor({ insights: "empty", graph: "on", growth: "none" });
const FRESH = worldFor({ insights: "new", graph: "on", growth: "none" });
const PAUSED = worldFor({ insights: "typical", graph: "off", growth: "some" });

/** A typical month: counts, two metrics with evidence, the weekly card row, milestones. */
export const Growth: Story = { render: () => <Page part="growth" edit={TYPICAL} /> };

/** A quiet period: nothing learned. */
export const GrowthEmpty: Story = { render: () => <Page part="growth" edit={QUIET} /> };

/** The radial map for a typical month. */
export const People: Story = { render: () => <Page part="people" edit={TYPICAL} /> };

/** A heavy year: the full 12 nodes on the rings. */
export const PeopleHeavy: Story = {
  render: () => <Page part="people" edit={HEAVY} period="all" />,
};

/** Compact (< 720 px): the list is the default view, the map is behind "Show map". */
export const PeopleCompact: Story = {
  render: () => <Page part="people" edit={TYPICAL} width={390} compact />,
};

/** The list equivalent at full width (after "Show as list"). */
export const PeopleList: Story = {
  render: () => <Page part="people" edit={TYPICAL} compact />,
};

/** Day 2: two entities on the rings. */
export const PeopleNewUser: Story = {
  render: () => <Page part="people" edit={FRESH} period="7d" />,
};

/** Nobody yet in this period. */
export const PeopleEmpty: Story = { render: () => <Page part="people" edit={QUIET} /> };

/** The people and projects graph is turned off. */
export const PeopleGraphPaused: Story = { render: () => <Page part="people" edit={PAUSED} /> };
