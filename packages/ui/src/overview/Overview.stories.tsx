import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { MockGateway } from "../data/mock-gateway.ts";
import type { InsightsFixtureState } from "../fixtures/index.ts";
import { InLocale, STORY_NOW, StoryWorld, withWorld } from "../stories/harness.tsx";
import { cn } from "../lib/utils.ts";
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
  locale,
  latency,
  failing = [],
  full = false,
}: {
  initial?: OverviewPeriod;
  firstActivityAt: string | null;
  width?: number;
  /** What `insights.summary` answers (null: a quiet install, every period empty). */
  insights?: InsightsFixtureState | null;
  /** Renders the page in this locale (`dir` follows it). */
  locale?: string;
  /** Delay of every Gateway answer in ms (a huge value keeps the page loading). */
  latency?: number;
  /** Gateway methods that always fail, so those sections show "Couldn’t load · Retry". */
  failing?: readonly string[];
  /** Lets the page take its full height, so a full-page screenshot shows every section. */
  full?: boolean;
}) {
  const [period, setPeriod] = useState<OverviewPeriod>(initial);
  const failAlways = (gateway: MockGateway): void => {
    if (failing.length === 0) return;
    const call = gateway.request.bind(gateway) as (method: string, ...rest: unknown[]) => unknown;
    (gateway as unknown as { request: unknown }).request = async (
      method: string,
      ...rest: unknown[]
    ) => {
      if (failing.includes(method)) throw new Error(`${method} is down`);
      return call(method, ...rest);
    };
  };
  const page = (
    <div
      className={cn(
        "flex flex-col bg-canvas",
        full ? "min-h-dvh" : "h-dvh min-h-0 overflow-auto",
      )}
      style={width === undefined ? {} : { width }}
    >
      <StoryWorld
        edit={insightsWorld(insights)}
        onGateway={failAlways}
        {...(latency === undefined ? {} : { options: { latency } })}
      >
        <OverviewScreen
          period={period}
          onPeriodChange={setPeriod}
          data={{ firstActivityAt }}
          now={STORY_NOW}
        />
      </StoryWorld>
    </div>
  );
  return locale === undefined ? page : <InLocale locale={locale}>{page}</InLocale>;
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

/** §5.5 loading: every section's skeleton, shown after the 150 ms delay in space that is reserved. */
export const Loading: Story = {
  render: () => <Page firstActivityAt={SIX_WEEKS_AGO} latency={3_600_000} />,
};

/** §5.5 error: Summary, Activity, Growth, People, Now and Recent fail alone; the rest still load. */
export const SectionErrors: Story = {
  render: () => (
    <Page
      firstActivityAt={SIX_WEEKS_AGO}
      initial="30d"
      failing={["insights.summary", "growth.summary", "runs.list"]}
    />
  ),
};

/** §5.8 long strings: German labels must not clip the tiles or the period control. */
export const DesktopDe: Story = {
  render: () => <Page firstActivityAt={SIX_WEEKS_AGO} initial="30d" locale="de-DE" />,
};

/** §5.8 long strings: Japanese in the same layout. */
export const DesktopJa: Story = {
  render: () => <Page firstActivityAt={SIX_WEEKS_AGO} initial="30d" locale="ja-JP" />,
};

/** §5.8 RTL: Arabic mirrors the time axis, the heatmap and the sparklines in one column. */
export const CompactAr: Story = {
  render: () => <Page firstActivityAt={SIX_WEEKS_AGO} initial="30d" width={390} locale="ar" />,
};

/** §5.8 RTL: Arabic on desktop, the full page mirrored. */
export const DesktopAr: Story = {
  render: () => <Page firstActivityAt={SIX_WEEKS_AGO} initial="30d" locale="ar" />,
};

/**
 * Full-page variants (tag `full-page`: the visual suite shoots the whole document, not just the
 * first 960×720 screen), so clipping lower down in de, ja and ar is caught too.
 */
export const DesktopDeFull: Story = {
  tags: ["full-page"],
  render: () => <Page firstActivityAt={SIX_WEEKS_AGO} initial="30d" locale="de-DE" full />,
};

export const DesktopJaFull: Story = {
  tags: ["full-page"],
  render: () => <Page firstActivityAt={SIX_WEEKS_AGO} initial="30d" locale="ja-JP" full />,
};

export const DesktopArFull: Story = {
  tags: ["full-page"],
  render: () => <Page firstActivityAt={SIX_WEEKS_AGO} initial="30d" locale="ar" full />,
};

export const CompactArFull: Story = {
  tags: ["full-page"],
  render: () => (
    <Page firstActivityAt={SIX_WEEKS_AGO} initial="30d" width={390} locale="ar" full />
  ),
};
