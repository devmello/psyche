import type { UpcomingItem } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSheetRoute } from "../src/agent/AgentSheet.tsx";
import { applyRunTrace } from "../src/fixtures/runs.ts";
import {
  cadenceMs,
  dayOffset,
  groupUpcoming,
  isFrequent,
  NowSection,
  OverviewRun,
  overviewAnchor,
  overviewRedirect,
  overviewRunHref,
  parseRecentFilter,
  RecentSection,
  recentRunsQuery,
  UpcomingSection,
  withRecentFilter,
} from "../src/overview/index.ts";
import { STORY_NOW, StoryWorld, type StoryWorldProps } from "../src/stories/harness.tsx";

afterEach(cleanup);

const HOUR = 3_600_000;

describe("the recent filter in the URL", () => {
  it("parses ?filter= and falls back to all", () => {
    expect(parseRecentFilter("/overview?filter=failed")).toBe("failed");
    expect(parseRecentFilter("/overview?period=30d&filter=automation#recent")).toBe("automation");
    expect(parseRecentFilter("filter=chat")).toBe("chat");
    expect(parseRecentFilter("/overview?filter=nope")).toBe("all");
    expect(parseRecentFilter("/overview")).toBe("all");
  });

  it("writes it back, keeping the period and the hash, and leaving all clean", () => {
    expect(withRecentFilter("/overview", "failed")).toBe("/overview?filter=failed");
    expect(withRecentFilter("/overview?period=30d", "chat")).toBe(
      "/overview?period=30d&filter=chat",
    );
    expect(withRecentFilter("/overview?period=30d&filter=chat", "all")).toBe(
      "/overview?period=30d",
    );
    expect(withRecentFilter("/overview?filter=failed#recent", "all")).toBe("/overview#recent");
  });

  it("asks the Gateway for finished runs, narrowed by outcome or kind", () => {
    expect(recentRunsQuery("all")).toEqual({ status: ["done", "failed", "cancelled"] });
    expect(recentRunsQuery("failed")).toEqual({ status: ["failed"] });
    expect(recentRunsQuery("automation").kind).toBe("automation");
    expect(recentRunsQuery("chat").kind).toBe("chat");
  });

  it("builds the Timeline route and reads a section anchor", () => {
    expect(overviewRunHref("run_1")).toBe("/overview/run/run_1");
    expect(overviewRunHref("run_1", { stepId: "stp 2" })).toBe("/overview/run/run_1?step=stp%202");
    expect(overviewAnchor("/overview#upcoming")).toBe("upcoming");
    expect(overviewAnchor("/overview")).toBeUndefined();
  });
});

describe("old agent routes", () => {
  it("still parse in the sheet, and map to the Overview", () => {
    const to = (route: string) => {
      const parsed = agentSheetRoute(route);
      return parsed === null ? "none" : overviewRedirect(parsed);
    };
    expect(to("/agent/activity")).toBe("/overview#now");
    expect(to("/agent/upcoming")).toBe("/overview#upcoming");
    expect(to("/agent/growth")).toBe("/overview#growth");
    expect(to("/agent/activity/run/run_1")).toBe("/overview/run/run_1");
    expect(to("/agent/activity/run/run_1?step=stp_2")).toBe("/overview/run/run_1?step=stp_2");
    // A task, Approvals and Soul & Memory stay in the sheet.
    expect(to("/agent/activity/task_1")).toBeNull();
    expect(to("/agent/approvals")).toBeNull();
    expect(to("/agent/soul?file=SOUL.md")).toBeNull();
  });
});

describe("upcoming groups", () => {
  const item = (schedule: string, nextRunAt: string): UpcomingItem => ({
    kind: "automation",
    id: schedule,
    title: schedule,
    nextRunAt,
    enabled: true,
    schedule,
  });
  const at = (days: number, hour = 9) =>
    new Date(STORY_NOW + days * 24 * HOUR + hour * 0).toISOString();

  it("reads the cadence of interval and stepped schedules", () => {
    expect(cadenceMs("PT45M")).toBe(45 * 60_000);
    expect(cadenceMs("PT6H")).toBe(6 * HOUR);
    expect(cadenceMs("*/5 * * * *")).toBe(5 * 60_000);
    expect(cadenceMs("0 */2 * * *")).toBe(2 * HOUR);
    expect(cadenceMs("0 7 * * 1-5")).toBeNull();
    expect(isFrequent("PT45M")).toBe(true);
    expect(isFrequent("PT24H")).toBe(false);
    expect(isFrequent("0 9 1 * *")).toBe(false);
  });

  it("counts calendar days in the owner's time zone", () => {
    const evening = Date.parse("2026-10-18T23:30:00Z");
    expect(dayOffset(evening + HOUR, evening, "UTC")).toBe(1);
    // 23:30 UTC is already the next morning in Tokyo, so one hour later is the same day there.
    expect(dayOffset(evening + HOUR, evening, "Asia/Tokyo")).toBe(0);
  });

  it("groups by day and collapses frequent automations into Today", () => {
    const entries = [
      item("PT45M", at(3)),
      item("0 7 * * 1-5", at(0)),
      item("0 8 * * *", at(1)),
      item("0 9 * * 3", at(4)),
      item("0 9 1 * *", at(14)),
    ].map((i) => ({ item: i, automation: undefined }));
    const groups = groupUpcoming(entries, STORY_NOW, "UTC");
    expect(groups.today.map((e) => e.item.schedule)).toEqual(["PT45M", "0 7 * * 1-5"]);
    expect(groups.tomorrow.map((e) => e.item.schedule)).toEqual(["0 8 * * *"]);
    expect(groups.week.map((e) => e.item.schedule)).toEqual(["0 9 * * 3"]);
    expect(groups.later.map((e) => e.item.schedule)).toEqual(["0 9 1 * *"]);
  });
});

function world(props: Omit<StoryWorldProps, "children">, ui: React.ReactNode) {
  const edit = props.edit;
  return render(
    <StoryWorld
      {...props}
      edit={(w) => {
        applyRunTrace(w);
        edit?.(w);
      }}
    >
      {ui}
    </StoryWorld>,
  );
}

describe("Now & next", () => {
  it("lists what is running and opens its Timeline in the Overview", async () => {
    const navigate = vi.fn();
    world({ slots: { navigate } }, <NowSection now={STORY_NOW} />);
    const running = await screen.findByRole("region", { name: "Running now" });
    fireEvent.click(
      within(running).getAllByRole("button", { name: /Dentist booking/ })[0] as HTMLElement,
    );
    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/overview\/run\//));
    expect(screen.getByRole("heading", { name: "Now & next" })).toBeTruthy();
  });

  it("shows the next scheduled runs", async () => {
    world({}, <NowSection now={STORY_NOW} />);
    const next = await screen.findByRole("region", { name: "Next up" });
    expect(within(next).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(within(next).getAllByRole("listitem").length).toBeLessThanOrEqual(3);
  });
});

describe("Upcoming", () => {
  it("groups by day, with a frequent automation as one row with its cadence", async () => {
    world({}, <UpcomingSection now={STORY_NOW} />);
    const today = await screen.findByTestId("overview-upcoming-today");
    expect(within(today).getByText("Heartbeat")).toBeTruthy();
    expect(within(today).getByText(/every 45 min/i)).toBeTruthy();
    expect(screen.getByTestId("overview-upcoming-later")).toBeTruthy();
    // Each automation appears once.
    expect(screen.getAllByText("Heartbeat")).toHaveLength(1);
  });

  it("keeps paused automations under a disclosure", async () => {
    world(
      {
        edit: (w) => {
          const a = w.automations.find((x) => x.title === "Subscription audit");
          if (a) a.enabled = false;
        },
      },
      <UpcomingSection now={STORY_NOW} />,
    );
    const toggle = await screen.findByRole("button", { name: "Paused (1)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Subscription audit")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Subscription audit")).toBeTruthy();
  });
});

describe("Recent runs", () => {
  it("filters to failed runs, searches by title, and opens the Timeline", async () => {
    const navigate = vi.fn();
    const onFilterChange = vi.fn();
    world(
      { slots: { navigate } },
      <RecentSection now={STORY_NOW} onFilterChange={onFilterChange} />,
    );
    const list = await screen.findByTestId("overview-recent-list");
    expect(within(list).getByText("Lisbon research")).toBeTruthy();
    expect(within(list).getByText("Subscription audit")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(onFilterChange).toHaveBeenCalledWith("failed");
    await waitFor(() => expect(screen.queryByText("Lisbon research")).toBeNull());
    const failed = await screen.findByRole("button", { name: /Subscription audit/ });
    fireEvent.click(failed);
    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/overview\/run\//));

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await screen.findByText("Lisbon research");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "lisbon" } });
    expect(screen.queryByText("Subscription audit")).toBeNull();
    expect(screen.getByText("Lisbon research")).toBeTruthy();
  });

  it("follows the filter held in the route", async () => {
    world({}, <RecentSection now={STORY_NOW} filter="automation" />);
    await screen.findAllByText("Morning brief");
    expect(screen.queryByText("Lisbon research")).toBeNull();
    expect(screen.getByRole("button", { name: "Automations" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("pages by cursor", async () => {
    world(
      {
        edit: (w) => {
          const base = w.runs.find((r) => r.status === "done" && r.kind === "chat");
          if (!base) throw new Error("fixture run missing");
          for (let i = 0; i < 40; i += 1) {
            w.runs.push({
              ...base,
              id: `run_page_${String(i).padStart(2, "0")}`,
              title: `Paged run ${i}`,
              startedAt: new Date(STORY_NOW - (i + 1) * 60_000 - 3 * 24 * HOUR).toISOString(),
              endedAt: new Date(STORY_NOW - i * 60_000 - 3 * 24 * HOUR).toISOString(),
            });
          }
        },
      },
      <RecentSection now={STORY_NOW} />,
    );
    const list = await screen.findByTestId("overview-recent-list");
    const before = within(list).getAllByRole("listitem").length;
    expect(before).toBeGreaterThan(20);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("overview-recent-list")).getAllByRole("listitem").length,
      ).toBeGreaterThan(before),
    );
  });
});

describe("the Timeline page", () => {
  it("has a back link named for the persona and the Timeline at full width", async () => {
    const onBack = vi.fn();
    world({}, <OverviewRun runId="run_missing" onBack={onBack} now={STORY_NOW} />);
    const back = screen.getByRole("button", { name: "Wren & you" });
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalled();
    expect(screen.getByTestId("overview-run").getAttribute("data-run-id")).toBe("run_missing");
  });
});
