import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import type { FixtureWorld } from "../fixtures/index.ts";
import { applyRunTrace, TRACE_IDS } from "../fixtures/runs.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { OverviewRun } from "./OverviewRun.tsx";
import { OverviewScreen } from "./OverviewScreen.tsx";
import { RecentSection } from "./RecentSection.tsx";
import { UpcomingSection } from "./UpcomingSection.tsx";

/**
 * Now & next, Upcoming and Recent runs on the Overview, and the Timeline page
 * (docs/design/agent-overview-2026.md §5.4). The visual baseline shoots Overview/* in light and
 * dark.
 */
const meta = {
  title: "Overview/Now & recent",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const DAY = 24 * 60 * 60 * 1000;
const SIX_WEEKS_AGO = new Date(STORY_NOW - 42 * DAY).toISOString();
const TWO_DAYS_AGO = new Date(STORY_NOW - 2 * DAY).toISOString();

/** Run-trace runs (running, failed, finished, ten morning briefs) and nothing else running. */
function trace(w: FixtureWorld): void {
  applyRunTrace(w);
  w.runs = w.runs.filter((r) => r.id.startsWith("run_trace_"));
  // One automation is switched off, so the Paused disclosure shows.
  const paused = w.automations.find((a) => a.title === "Subscription audit");
  if (paused) paused.enabled = false;
}

function Page({
  firstActivityAt = SIX_WEEKS_AGO,
  width,
  route = "/overview?period=30d",
}: {
  firstActivityAt?: string | null;
  width?: number;
  route?: string;
}) {
  return (
    <div
      className="flex h-dvh min-h-0 flex-col overflow-auto bg-canvas"
      style={width === undefined ? {} : { width }}
    >
      <OverviewScreen
        period="30d"
        onPeriodChange={() => {}}
        data={{ firstActivityAt }}
        now={STORY_NOW}
        route={route}
        onNavigate={() => {}}
      />
    </div>
  );
}

/** Running work, the next three runs, Upcoming by day with the heartbeat as one row, Recent runs. */
export const Desktop: Story = {
  decorators: [withWorld({ edit: trace })],
  render: () => <Page />,
};

/** Compact (< 720 px): one column. */
export const Compact: Story = {
  decorators: [withWorld({ edit: trace })],
  render: () => <Page width={390} />,
};

/** Recent runs filtered to failures, the way a "4 failed" link lands. */
export const FailedFilter: Story = {
  decorators: [withWorld({ edit: trace })],
  render: () => <Page route="/overview?period=30d&filter=failed" />,
};

/** Nothing running, nothing scheduled, no runs: the quiet empty lines. */
export const Empty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.runs = [];
        w.tasks = [];
        w.automations = [];
        w.approvals = [];
        w.inputRequests = [];
      },
    }),
  ],
  render: () => <Page />,
};

/** First week: Now & next and Upcoming under the "getting to know you" card. */
export const NewUser: Story = {
  decorators: [withWorld({ edit: trace })],
  render: () => <Page firstActivityAt={TWO_DAYS_AGO} />,
};

/** `/overview/run/<id>`: the Timeline at full width under "← Wren & you". */
export const TimelinePage: Story = {
  decorators: [withWorld({ edit: trace })],
  render: () => (
    <div className="flex h-dvh min-h-0 flex-col overflow-auto bg-canvas">
      <OverviewRun runId={TRACE_IDS.runs.failed} onBack={() => {}} now={STORY_NOW} />
    </div>
  ),
};

function Column({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex max-w-[1040px] flex-col gap-4 bg-canvas p-6">{children}</div>;
}

/** Upcoming alone: Today (the heartbeat as one "every 45 min" row), Later, and Paused (1). */
export const Upcoming: Story = {
  decorators: [withWorld({ edit: trace })],
  render: () => (
    <Column>
      <UpcomingSection now={STORY_NOW} />
    </Column>
  ),
};

/** Recent runs alone: filters, search and finished runs, newest first. */
export const Recent: Story = {
  decorators: [withWorld({ edit: trace })],
  render: () => (
    <Column>
      <RecentSection period="30d" now={STORY_NOW} />
    </Column>
  ),
};
