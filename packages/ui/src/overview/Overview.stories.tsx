import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { InsightsFixtureState } from "../fixtures/index.ts";
import { STORY_NOW, StoryWorld, withWorld } from "../stories/harness.tsx";
import { OverviewScreen } from "./OverviewScreen.tsx";
import type { OverviewPeriod } from "./period.ts";
import { insightsWorld } from "./storyWorld.ts";

/**
 * The Overview shell, "{persona} & you" (docs/design/agent-overview-2026.md §5.1, §5.5): toolbar,
 * period control, section placeholders, and the new-user state. The visual baseline shoots
 * Overview/* in light and dark.
 */
const meta = {
  title: "Overview/Screen",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const SIX_WEEKS_AGO = new Date(STORY_NOW - 42 * 24 * 60 * 60 * 1000).toISOString();
const TWO_DAYS_AGO = new Date(STORY_NOW - 2 * 24 * 60 * 60 * 1000).toISOString();

function Page({
  initial = "7d",
  firstActivityAt,
  width,
  insights = "typical",
}: {
  initial?: OverviewPeriod;
  firstActivityAt: string | null;
  width?: number;
  /** What `insights.summary` answers (null: a quiet install, every period empty). */
  insights?: InsightsFixtureState | null;
}) {
  const [period, setPeriod] = useState<OverviewPeriod>(initial);
  return (
    <div
      className="flex h-dvh min-h-0 flex-col overflow-auto bg-canvas"
      style={width === undefined ? {} : { width }}
    >
      <StoryWorld edit={insightsWorld(insights)}>
        <OverviewScreen
          period={period}
          onPeriodChange={setPeriod}
          data={{ firstActivityAt }}
          now={STORY_NOW}
        />
      </StoryWorld>
    </div>
  );
}

/** Desktop: all eight section anchors as framed cards. */
export const Desktop: Story = { render: () => <Page firstActivityAt={SIX_WEEKS_AGO} /> };

/** Compact (< 720 px): one column, no jump bar. */
export const Compact: Story = {
  render: () => <Page firstActivityAt={SIX_WEEKS_AGO} initial="30d" width={390} />,
};

/** §5.5: under seven days of activity, a "getting to know you" card, Now & next and Upcoming. */
export const NewUser: Story = {
  render: () => <Page firstActivityAt={TWO_DAYS_AGO} insights="new" />,
};

/** All time reads "Since {first activity}". The Overview group is shot in light and dark. */
export const AllTime: Story = {
  render: () => <Page firstActivityAt={SIX_WEEKS_AGO} initial="all" insights="heavy" />,
};

/** §5.4 Summary and Activity over a month: the sentence, four tiles, stacked bars and the facts. */
export const Month: Story = {
  render: () => <Page firstActivityAt={SIX_WEEKS_AGO} initial="30d" />,
};

/** §5.5 sparse period: tiles show 0, the chart an empty axis and "Nothing this week." */
export const QuietWeek: Story = {
  render: () => <Page firstActivityAt={SIX_WEEKS_AGO} insights={null} />,
};
