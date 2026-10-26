import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnection } from "../src/data/index.ts";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { type FixtureWorld, insightsFixtures } from "../src/fixtures/index.ts";
import { OverviewActivity } from "../src/overview/ActivitySection.tsx";
import { BuiltForYou, Specialists } from "../src/overview/BuiltSpecialists.tsx";
import { GrowthSection } from "../src/overview/GrowthSection.tsx";
import { NowSection } from "../src/overview/NowSection.tsx";
import { OverviewScreen } from "../src/overview/OverviewScreen.tsx";
import { PeopleSection } from "../src/overview/PeopleSection.tsx";
import { RecentSection } from "../src/overview/RecentSection.tsx";
import { OverviewSummary } from "../src/overview/SummarySection.tsx";
import { UpcomingSection } from "../src/overview/UpcomingSection.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/**
 * Loading, error and stale states of every Overview section (agent-overview-2026 §5.5,
 * smoothness-2026 C4): a skeleton only after 150 ms, never an empty state while loading, an
 * inline "Couldn't load · Retry" per section, and old data kept (with "Last updated") when a
 * refetch fails.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const typical = (world: FixtureWorld): void => {
  Object.assign(world, { insights: insightsFixtures("typical") });
};

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

interface Case {
  name: string;
  id: string;
  /** The Gateway methods this section reads (one is made to fail). */
  method: Parameters<MockGateway["failNext"]>[0];
  element: () => ReactElement;
  /** Copy that would be wrong to show while loading. */
  empty: RegExp;
  edit?: (w: FixtureWorld) => void;
}

const CASES: Case[] = [
  {
    name: "Summary",
    id: "summary",
    method: "insights.summary",
    element: () => <OverviewSummary period="30d" />,
    empty: /^0$/,
  },
  {
    name: "Activity",
    id: "activity",
    method: "insights.summary",
    element: () => <OverviewActivity period="30d" />,
    empty: /Nothing/i,
  },
  {
    name: "Now & next",
    id: "now",
    method: "approvals.list",
    element: () => <NowSection now={STORY_NOW} />,
    empty: /Nothing|nothing/,
  },
  {
    name: "Growth",
    id: "growth",
    method: "growth.summary",
    element: () => <GrowthSection period="30d" now={STORY_NOW} />,
    empty: /No lessons|Nothing/i,
  },
  {
    name: "People",
    id: "people",
    method: "memory.graph.status",
    element: () => <PeopleSection period="30d" now={STORY_NOW} />,
    empty: /isn’t|No people|Nothing/i,
  },
  {
    name: "Built",
    id: "built",
    method: "artifacts.list",
    element: () => <BuiltForYou period="30d" now={STORY_NOW} />,
    empty: /Nothing|haven’t/i,
  },
  {
    name: "Specialists",
    id: "specialists",
    method: "specialists.list",
    element: () => <Specialists period="30d" now={STORY_NOW} />,
    empty: /Nothing|No /i,
  },
  {
    name: "Upcoming",
    id: "upcoming",
    method: "automations.upcoming",
    element: () => <UpcomingSection now={STORY_NOW} />,
    empty: /Nothing|No /i,
  },
  {
    name: "Recent",
    id: "recent",
    method: "runs.list",
    element: () => <RecentSection period="30d" now={STORY_NOW} />,
    empty: /No recent|No matches|Nothing/i,
  },
];

function world(c: Case, latency = 0, onGateway?: (g: MockGateway) => void) {
  return (
    <StoryWorld
      edit={c.edit ?? typical}
      options={{ latency }}
      {...(onGateway === undefined ? {} : { onGateway })}
    >
      <div data-testid="overview" className="@container/overview">
        {c.element()}
      </div>
    </StoryWorld>
  );
}

describe("delayed skeleton", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  for (const c of CASES.filter((x) => x.id !== "specialists")) {
    it(`${c.name}: reserves its space, shows nothing before 150 ms, then a skeleton, never "empty"`, async () => {
      render(world(c, 400));
      await advance(0);
      const skeleton = screen.getByTestId(`overview-${c.id}-loading`);
      // Space is reserved from frame 0 but nothing is visible or announced yet.
      expect(skeleton.getAttribute("data-shown")).toBe("false");
      expect(skeleton.getAttribute("aria-hidden")).toBe("true");
      expect(screen.queryByRole("status")).toBeNull();
      await advance(149);
      expect(skeleton.getAttribute("data-shown")).toBe("false");
      await advance(2);
      const shown = screen.getByTestId(`overview-${c.id}-loading`);
      expect(shown.getAttribute("data-shown")).toBe("true");
      expect(within(shown).queryByText(c.empty)).toBeNull();
      expect(screen.getByRole("status").getAttribute("aria-label")).toMatch(/Loading/);
      // No empty-state copy anywhere while loading.
      expect(screen.queryByText(c.empty)).toBeNull();
      // The data arrives and the skeleton goes.
      await advance(2000);
      expect(screen.queryByTestId(`overview-${c.id}-loading`)).toBeNull();
    });
  }

  it("never shows a skeleton when the data arrives within 150 ms", async () => {
    render(world(CASES[1] as Case, 40));
    await advance(0);
    const skeleton = screen.getByTestId("overview-activity-loading");
    await advance(100);
    expect(screen.queryByTestId("overview-activity-loading")).toBeNull();
    expect(skeleton.getAttribute("data-shown")).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("error and Retry", () => {
  for (const c of CASES) {
    it(`${c.name}: a failed load says so inline and Retry loads it`, async () => {
      let gateway: MockGateway | undefined;
      render(
        world(c, 0, (g) => {
          gateway = g;
          g.failNext(c.method, "unavailable");
        }),
      );
      const section = c.id === "summary" ? screen.getByTestId("overview-summary") : null;
      const alert = await screen.findByTestId("overview-load-failed", {}, { timeout: 3000 });
      expect(alert.getAttribute("role")).toBe("alert");
      if (c.id !== "summary") expect(alert.textContent).toMatch(/Couldn’t load/);
      // The failure is this section's; the rest of the page isn't affected.
      expect(screen.getAllByTestId("overview-load-failed")).toHaveLength(1);
      if (section) expect(section.contains(alert)).toBe(true);
      expect(gateway).toBeDefined();
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
      await vi.waitFor(() => expect(screen.queryByTestId("overview-load-failed")).toBeNull(), {
        timeout: 3000,
      });
    });
  }
});

function Refresh(): ReactElement {
  const { retry } = useConnection();
  return (
    <button type="button" onClick={() => void retry().catch(() => {})}>
      refresh
    </button>
  );
}

describe("stale data", () => {
  it("keeps showing the data and says when it was last updated if a refetch fails", async () => {
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld edit={typical} onGateway={(g) => (gateway = g)}>
        <Refresh />
        <OverviewScreen
          period="30d"
          onPeriodChange={() => {}}
          data={{ firstActivityAt: new Date(STORY_NOW - 60 * 86_400_000).toISOString() }}
          now={STORY_NOW}
        />
      </StoryWorld>,
    );
    await screen.findByTestId("overview-activity-facts", {}, { timeout: 3000 });
    expect(screen.queryByTestId("overview-last-updated")).toBeNull();
    gateway?.failNext("insights.summary", "unavailable");
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    const note = await screen.findByTestId("overview-last-updated", {}, { timeout: 3000 });
    expect(note.textContent).toMatch(/Last updated \d/);
    // The old numbers stay on screen; nothing became an error or a skeleton.
    expect(screen.getByTestId("overview-activity-facts")).toBeTruthy();
    expect(screen.queryByTestId("overview-activity-loading")).toBeNull();
    expect(screen.queryByTestId("overview-load-failed")).toBeNull();
  });
});
